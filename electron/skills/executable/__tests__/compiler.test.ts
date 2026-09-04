import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setPilotRoot } from '../../../piskiepilot/paths.js';
import {
  compileExecutableSkill,
  ExecutableSkillCompileError,
  validateBrowserSkillSource,
} from '../compiler.js';

const COMPILE_TEST_TIMEOUT_MS = 20_000;

describe('compileExecutableSkill', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'piskie-executable-compiler-'));
    setPilotRoot(path.join(root, 'pilot'));
  }, COMPILE_TEST_TIMEOUT_MS);

  afterEach(async () => {
    setPilotRoot(path.join(process.cwd(), '.piskiepilot'));
    await rm(root, { recursive: true, force: true });
  }, COMPILE_TEST_TIMEOUT_MS);

  it('compiles the minimal Browser profile with the host-provided SDK', async () => {
    const source = await makeSource('browser-demo', 'browser', [
      "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
      "export default defineSkill({ name: 'browser-demo', domain: 'browser', functions: {",
      "  inspect: { description: 'Inspect page', params: z.object({}),",
      '    async run(_params, ctx) { return ok(JSON.stringify(await ctx.browser.page.currentPage())) },',
      '  },',
      '} })',
    ].join('\n'));

    const candidate = await compileExecutableSkill(source, 'browser-demo', { profile: 'browser' });

    expect(candidate.profile).toBe('browser');
    await expect(access(candidate.modulePath)).resolves.toBeUndefined();
    expect(await readFile(path.join(candidate.buildDir, 'package.json'), 'utf8'))
      .toContain('"type": "module"');
  }, COMPILE_TEST_TIMEOUT_MS);

  it('compiles Browser Skills that list and select browser tabs through the public SDK', async () => {
    const source = await makeSource('browser-tabs', 'browser', [
      "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
      "export default defineSkill({ name: 'browser-tabs', domain: 'browser', functions: {",
      "  inspectDetail: { description: 'Inspect a newly opened detail tab', params: z.object({}),",
      '    async run(_params, ctx) {',
      '      const pages = await ctx.browser.listPages()',
      '      const detail = pages.find((page) => !page.selected)',
      "      if (!detail) return ok('no detail tab')",
      '      return ok(JSON.stringify(await ctx.browser.selectPage(detail.pageIdx)))',
      '    },',
      '  },',
      '} })',
    ].join('\n'));

    const candidate = await compileExecutableSkill(source, 'browser-tabs', { profile: 'browser' });

    expect(candidate.profile).toBe('browser');
    await expect(access(candidate.modulePath)).resolves.toBeUndefined();
  }, COMPILE_TEST_TIMEOUT_MS);

  it("compiles the canonical BrowserSkillRuntime['page'] author type", async () => {
    const source = await makeSource('browser-page-type', 'browser', [
      "import { defineSkill, ok, z, type BrowserSkillRuntime } from 'piskiepilot/core-skill'",
      "type Page = BrowserSkillRuntime['page']",
      'async function readTitle(page: Page) { return (await page.currentPage()).title }',
      "export default defineSkill({ name: 'browser-page-type', domain: 'browser', functions: {",
      "  inspect: { description: 'Inspect page', params: z.object({}),",
      '    async run(_params, ctx) { return ok(await readTitle(ctx.browser.page)) },',
      '  },',
      '} })',
    ].join('\n'));

    const candidate = await compileExecutableSkill(source, 'browser-page-type', {
      profile: 'browser',
    });

    expect(candidate.profile).toBe('browser');
    await expect(access(candidate.modulePath)).resolves.toBeUndefined();
  }, COMPILE_TEST_TIMEOUT_MS);

  it('keeps standard executable Skill helpers, package metadata, and tsconfig semantics', async () => {
    const source = await makeSource('local-demo', 'local', [
      "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
      "import { decorate } from './helper.js'",
      "export default defineSkill({ name: 'local-demo', domain: 'local', functions: {",
      "  run: { description: 'Run helper', params: z.object({ value: z.string() }),",
      '    async run({ value }) { return ok(decorate(value)) },',
      '  },',
      '} })',
    ].join('\n'));
    await writeFile(path.join(source, 'helper.ts'), "export const decorate = (value: string) => `seen:${value}`\n", 'utf8');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'local-demo-source',
      private: true,
      type: 'module',
    }, null, 2), 'utf8');
    await writeFile(path.join(source, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext' },
    }, null, 2), 'utf8');

    const candidate = await compileExecutableSkill(source, 'local-demo', { profile: 'standard' });

    expect(candidate.profile).toBe('standard');
    await expect(access(path.join(candidate.buildDir, 'module', 'helper.js'))).resolves.toBeUndefined();
    expect(await readFile(path.join(candidate.buildDir, 'package.json'), 'utf8'))
      .toContain('local-demo-source');
  }, COMPILE_TEST_TIMEOUT_MS);

  it('reuses a complete standard dependency environment and repairs it only when damaged', async () => {
    const source = await makeSource('dependency-demo', 'local', [
      "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
      "import { decorate } from 'fixture-dep'",
      "export default defineSkill({ name: 'dependency-demo', domain: 'local', functions: {",
      "  run: { description: 'Run dependency', params: z.object({ value: z.string() }),",
      '    async run({ value }) { return ok(decorate(value)) },',
      '  },',
      '} })',
    ].join('\n'));
    const dependency = path.join(source, 'vendor', 'fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({
      name: 'fixture-dep',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
      types: './index.d.ts',
    }, null, 2), 'utf8');
    await writeFile(path.join(dependency, 'index.js'), 'export const decorate = value => `dep:${value}`\n', 'utf8');
    await writeFile(path.join(dependency, 'index.d.ts'), 'export declare const decorate: (value: string) => string\n', 'utf8');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'dependency-demo-source',
      private: true,
      type: 'module',
      dependencies: { 'fixture-dep': 'file:vendor/fixture-dep' },
      scripts: {
        postinstall: "node -e \"const fs=require('fs');const p='install-count.txt';const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0);fs.writeFileSync(p,String(n+1))\"",
      },
    }, null, 2), 'utf8');

    const first = await compileExecutableSkill(source, 'dependency-demo', { profile: 'standard' });
    expect(await readFile(path.join(first.buildDir, 'install-count.txt'), 'utf8')).toBe('1');

    const bridgePath = path.join(first.buildDir, 'node_modules', 'piskiepilot', 'core-skill.js');
    const typeBridgePath = path.join(first.buildDir, 'node_modules', 'piskiepilot', 'core-skill.d.ts');
    await writeFile(bridgePath, "export const stale = true\n", 'utf8');

    const cached = await compileExecutableSkill(source, 'dependency-demo', { profile: 'standard' });
    expect(cached.buildDir).toBe(first.buildDir);
    expect(await readFile(path.join(first.buildDir, 'install-count.txt'), 'utf8')).toBe('1');
    expect(await readFile(bridgePath, 'utf8')).toContain('author-api');
    expect(await readFile(typeBridgePath, 'utf8')).toContain('author-api.ts');

    await rm(path.join(first.buildDir, 'node_modules', 'fixture-dep'), { recursive: true, force: true });
    const repaired = await compileExecutableSkill(source, 'dependency-demo', { profile: 'standard' });
    expect(repaired.buildDir).toBe(first.buildDir);
    expect(await readFile(path.join(first.buildDir, 'install-count.txt'), 'utf8')).toBe('2');
    await expect(access(path.join(first.buildDir, 'node_modules', 'fixture-dep', 'package.json')))
      .resolves.toBeUndefined();
  }, COMPILE_TEST_TIMEOUT_MS);

  it.each(['package.json', 'helper.ts', '.env'])(
    'rejects Browser profile root file %s',
    async (extra) => {
      const source = await makeSource('browser-layout', 'browser', validBrowserSource('browser-layout'));
      await writeFile(path.join(source, extra), 'not allowed\n', 'utf8');

      await expect(compileExecutableSkill(source, 'browser-layout', { profile: 'browser' }))
        .rejects.toThrow(`optional references/: ${extra}`);
    },
  );

  it('reports forbidden imports, host/network escape hatches, and UID persistence with source positions', () => {
    const diagnostics = validateBrowserSkillSource([
      "import fs from 'node:fs'",
      "const savedUid = '10_116'",
      "const response = fetch('https://example.com')",
      'void fs; void savedUid; void response',
    ].join('\n'));

    expect(diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'BSP1001',
      'BSP1004',
      'BSP1005',
      'BSP1006',
    ]));
    expect(diagnostics.every(({ line, column }) => line > 0 && column > 0)).toBe(true);
  });

  it('applies the import allowlist to re-exports', () => {
    const diagnostics = validateBrowserSkillSource([
      "export * from 'node:fs'",
      "export { default as browser } from 'puppeteer'",
      "export { z } from 'piskiepilot/core-skill'",
    ].join('\n'));

    expect(diagnostics.filter(({ code }) => code === 'BSP1001')).toHaveLength(2);
    expect(diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
      expect.stringContaining('node:fs'),
      expect.stringContaining('puppeteer'),
    ]));
  });

  it('rejects triple-slash references so references/ cannot extend the compiled source graph', () => {
    const diagnostics = validateBrowserSkillSource([
      '/// <reference path="./references/host-bypass.d.ts" />',
      "import { defineSkill } from 'piskiepilot/core-skill'",
      'void defineSkill',
    ].join('\n'));

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BSP1010' }),
    ]));
  });

  it('rejects straightforward SDK type/global bypasses but permits stable site business IDs', () => {
    const diagnostics = validateBrowserSkillSource([
      '// @ts-ignore',
      "const unsafe = globalThis['fetch']",
      'const page = ctx.browser.page as any',
      'const annotatedPage: any = ctx.browser.page',
      'annotatedPage.magicClick()',
      "const reflected = Reflect.get(globalThis, 'process')",
      'void unsafe; void page; void reflected',
    ].join('\n'));

    expect(diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'BSP1004',
      'BSP1008',
      'BSP1009',
      'BSP1011',
    ]));

    expect(validateBrowserSkillSource([
      "const locatorKinds = ['role', 'css'] as const",
      "const result = { offerId: 'offer-from-page', itemId: 'item-from-page', selectionKey: 'stable-key' }",
      'void locatorKinds; void result',
    ].join('\n'))).toEqual([]);
  });

  it('returns TypeScript diagnostics without replacing them with a generic build error', async () => {
    const source = await makeSource('browser-invalid', 'browser', [
      "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
      "export default defineSkill({ name: 'browser-invalid', domain: 'browser', functions: {",
      "  run: { description: 'Invalid SDK call', params: z.object({}),",
      '    async run(_params, ctx) { await ctx.browser.page.magicClick(); return ok(\'done\') },',
      '  },',
      '} })',
    ].join('\n'));

    const error = await compileExecutableSkill(source, 'browser-invalid', { profile: 'browser' })
      .then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExecutableSkillCompileError);
    expect((error as ExecutableSkillCompileError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'skill.ts', code: 'TS2339' }),
    ]));
  }, COMPILE_TEST_TIMEOUT_MS);

  async function makeSource(name: string, type: 'browser' | 'local', skillSource: string): Promise<string> {
    const source = path.join(root, name);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `type: ${type}`,
      `description: ${name} fixture`,
      '---',
      '',
      '# Fixture',
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(source, 'skill.ts'), `${skillSource}\n`, 'utf8');
    return source;
  }
});

function validBrowserSource(name: string): string {
  return [
    "import { defineSkill, ok, z } from 'piskiepilot/core-skill'",
    `export default defineSkill({ name: '${name}', domain: 'browser', functions: {`,
    "  run: { description: 'Run', params: z.object({}), async run() { return ok('done') } },",
    '} })',
  ].join('\n');
}
