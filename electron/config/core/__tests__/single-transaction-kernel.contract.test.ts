import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const controlPlane = fileURLToPath(
  new URL('../../../inference/control/control-plane.ts', import.meta.url),
);
const legacyLocalCatalogRepository = fileURLToPath(
  new URL('../../../inference/catalog/local-repository.ts', import.meta.url),
);
const legacyPlanStore = fileURLToPath(
  new URL('../../../inference/control/plan-store.ts', import.meta.url),
);
const legacyJsonPatch = fileURLToPath(
  new URL('../../../inference/control/json-patch.ts', import.meta.url),
);
const contracts = fileURLToPath(new URL('../../../../shared/electron-contracts/configuration.ts', import.meta.url));
const controller = fileURLToPath(new URL('../../../capabilities/configuration/configuration-controller.ts', import.meta.url));
const preload = fileURLToPath(new URL('../../../preload.ts', import.meta.url));
const rendererTypes = fileURLToPath(new URL('../../../../src/platform/electron/global.d.ts', import.meta.url));
const inferenceStore = fileURLToPath(new URL('../../../../src/store/inferenceStore.ts', import.meta.url));
const configRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('single configuration transaction kernel contract', () => {
  it('keeps inference services free of a second transaction implementation', () => {
    const controlSource = fs.readFileSync(controlPlane, 'utf8');

    expect(fs.existsSync(legacyLocalCatalogRepository)).toBe(false);
    expect(fs.existsSync(legacyPlanStore)).toBe(false);
    expect(fs.existsSync(legacyJsonPatch)).toBe(false);
    expect(controlSource).not.toMatch(/\bConfigPlanStore\b/);
    expect(controlSource).not.toMatch(/\brepository\.(?:commit|readRevision)\s*\(/);
    expect(controlSource).not.toMatch(
      /^\s+async\s+(?:createPlan|locatePlan|validate|probe|apply|rollback|history|show)\s*\(/m,
    );
  });

  it('exposes config lifecycle only through the generic Config IPC', () => {
    const surface = [contracts, controller, preload, rendererTypes]
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');
    for (const channel of [
      'inference:get-config',
      'inference:get-schema',
      'inference:get-selections',
      'inference:update-selections',
      'inference:get-catalog',
      'inference:get-catalog-schema',
      'inference:upsert-catalog-model',
      'inference:remove-catalog-model',
      'inference:verify-catalog',
      'inference:create-plan',
      'inference:validate-plan',
      'inference:probe-plan',
      'inference:apply-plan',
      'inference:verify',
      'inference:history',
      'inference:rollback',
    ]) {
      expect(surface, channel).not.toContain(channel);
    }

    const storeSource = fs.readFileSync(inferenceStore, 'utf8');
    expect(storeSource).toContain('applyConfigFieldChanges');
    expect(storeSource).not.toContain('ConfigPatchOperation');
    expect(storeSource).not.toContain('escapeJsonPointer');
    expect(storeSource).not.toMatch(/piskie\.inference\.(?:getConfig|createPlan|applyPlan|verify)/);
  });

  it('keeps filesystem replacement inside one platform-neutral Atomic Writer', () => {
    const sources = typescriptFiles(configRoot).map((filePath) => ({
      filePath,
      relativePath: path.relative(configRoot, filePath).split(path.sep).join('/'),
      source: fs.readFileSync(filePath, 'utf8'),
    }));
    const replacementOwners = sources
      .filter(({ source }) => /\b(?:fs|fileSystem)\.rename\s*\(/.test(source))
      .map(({ relativePath }) => relativePath);
    const platformOwners = sources
      .filter(({ source }) => /process\.platform|platform\s*===\s*['"]win32['"]/.test(source))
      .map(({ relativePath }) => relativePath);

    expect(replacementOwners).toEqual(['core/atomic-file-writer.ts']);
    expect(platformOwners).toEqual([]);
  });
});

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : typescriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}
