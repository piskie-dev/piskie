import fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { specRegistry } from '../specs/index.js';
import { BUILTIN_AGENT_SPECS } from '../specs/builtin/index.js';

describe('AgentSpec registry', () => {
  it('registers exactly the single built-in Spec manifest', () => {
    expect(specRegistry.getAll()).toEqual(BUILTIN_AGENT_SPECS);
  });

  it('requires every built-in Spec source to be present in the manifest', async () => {
    const sourceNames = (await fs.readdir(new URL('../specs/builtin', import.meta.url)))
      .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
      .map((name) => name.slice(0, -'.ts'.length))
      .sort();

    expect(BUILTIN_AGENT_SPECS.map((spec) => spec.name).sort()).toEqual(sourceNames);
  });

  it('does not register the retired direct-execution top-level spec', () => {
    const retiredName = ['stand', 'alone'].join('');

    expect(specRegistry.get(retiredName)).toBeUndefined();
    expect(specRegistry.getAll().map(spec => spec.name)).not.toContain(retiredName);
  });

  it('uses only director and worker roles', () => {
    expect(new Set(specRegistry.getAll().map(spec => spec.role))).toEqual(
      new Set(['director', 'worker']),
    );
  });

  it('exposes task_read to directors but not workers', () => {
    const specs = specRegistry.getAll();
    for (const spec of specs.filter((candidate) => candidate.role === 'director')) {
      expect(spec.tools.customTools, spec.name).toContain('task_read');
    }
    for (const spec of specs.filter((candidate) => candidate.role === 'worker')) {
      expect(spec.tools.customTools, spec.name).not.toContain('task_read');
    }
  });
});
