import { describe, expect, it, vi } from 'vitest';
import { createComponentManifest, type RuntimeComponent } from '../component-manifest.js';
import { ResourceLedger } from '../lifecycle/resource-ledger.js';
import { ResourceScope } from '../lifecycle/resource-scope.js';
import { ShutdownCoordinator } from '../lifecycle/shutdown-coordinator.js';

const component = (
  id: string,
  requirement: 'required' | 'optional' = 'required',
  dependsOn: readonly string[] = [],
): RuntimeComponent => ({
  id,
  requirement,
  dependsOn,
  async start() {},
  async stop() {},
  async verifyStopped() { return { state: 'stopped' }; },
});

describe('component manifest', () => {
  it('builds deterministic dependency layers', () => {
    const manifest = createComponentManifest([
      component('storage'),
      component('agent', 'required', ['storage']),
      component('watcher', 'optional', ['storage']),
      component('im', 'required', ['agent']),
    ]);

    expect(manifest.layers.map((layer) => layer.map(({ id }) => id))).toEqual([
      ['storage'],
      ['agent', 'watcher'],
      ['im'],
    ]);
  });

  it('rejects duplicate, missing, cyclic and unsafe optional dependencies', () => {
    expect(() => createComponentManifest([component('a'), component('a')]))
      .toThrow('Duplicate component id');
    expect(() => createComponentManifest([component('a', 'required', ['missing'])]))
      .toThrow('unknown component');
    expect(() => createComponentManifest([
      component('a', 'required', ['b']),
      component('b', 'required', ['a']),
    ])).toThrow('dependency cycle');
    expect(() => createComponentManifest([
      component('watch', 'optional'),
      component('core', 'required', ['watch']),
    ])).toThrow('depends on optional component');
  });
});

describe('resource ownership', () => {
  it('closes resources in reverse acquisition order and continues after failure', async () => {
    const ledger = new ResourceLedger('g1');
    const scope = new ResourceScope('g1', 'component:test', ledger);
    const calls: string[] = [];
    let firstLive = true;
    let secondLive = true;
    scope.register({
      kind: 'custom',
      label: 'first',
      close: () => {
        calls.push('first');
        firstLive = false;
      },
      inspect: () => firstLive ? 'live' : 'closed',
    });
    scope.register({
      kind: 'custom',
      label: 'second',
      close: () => {
        calls.push('second');
        secondLive = false;
        throw new Error('close failed after release');
      },
      inspect: () => secondLive ? 'live' : 'closed',
    });

    const results = await scope.close('test');
    expect(calls).toEqual(['second', 'first']);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'failed' }),
      expect.objectContaining({ outcome: 'closed' }),
    ]));
    await expect(ledger.assertEmpty()).resolves.toEqual({ empty: true, residuals: [] });
    await expect(scope.close('again')).resolves.toBe(results);
    expect(() => scope.register({
      kind: 'custom',
      label: 'late',
      close: () => undefined,
      inspect: () => 'closed',
    })).toThrow('is closed');
  });

  it('retains live and unknown resources for terminal verification', async () => {
    const ledger = new ResourceLedger('g1');
    ledger.register('component:a', {
      kind: 'server',
      label: 'live-server',
      close: () => undefined,
      inspect: () => 'live',
    });
    ledger.register('component:b', {
      kind: 'socket',
      label: 'unknown-socket',
      close: () => undefined,
      inspect: () => 'unknown',
    });

    await ledger.closeAll('quit');
    const verification = await ledger.assertEmpty();
    expect(verification.empty).toBe(false);
    expect(verification.residuals.map(({ inspection }) => inspection).sort())
      .toEqual(['live', 'unknown']);
  });
});

describe('ShutdownCoordinator', () => {
  it('coalesces concurrent requests and keeps the first reason', async () => {
    const coordinator = new ShutdownCoordinator<string>();
    const shutdown = vi.fn(async (reason: string) => reason);

    const first = coordinator.request('menu', shutdown);
    const second = coordinator.request('signal', shutdown);

    expect(second).toBe(first);
    await expect(first).resolves.toBe('menu');
    expect(coordinator.reason).toBe('menu');
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
