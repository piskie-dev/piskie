import { describe, expect, it, vi } from 'vitest';
import type { RuntimeComponent } from '../component-manifest.js';
import { BackendRuntime } from '../lifecycle/backend-runtime.js';
import { BackendLifecycleError, BackendStartError } from '../lifecycle/runtime-state.js';

interface FakeOptions {
  requirement?: 'required' | 'optional';
  dependsOn?: readonly string[];
  start?: (signal: AbortSignal) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  forceClose?: () => Promise<void> | void;
  closeResource?: () => Promise<void> | void;
  inspect?: () => 'live' | 'closed' | 'unknown';
  verify?: () => 'stopped' | 'live' | 'unknown';
  stopTimeoutMs?: number;
  calls?: string[];
}

function fakeComponent(id: string, options: FakeOptions = {}): RuntimeComponent<string> {
  let live = false;
  return {
    id,
    requirement: options.requirement ?? 'required',
    dependsOn: options.dependsOn ?? [],
    stopTimeoutMs: options.stopTimeoutMs,
    async start(_context, scope) {
      options.calls?.push(`start:${id}`);
      live = true;
      scope.register({
        kind: 'custom',
        label: `${id}-resource`,
        close: async () => {
          options.calls?.push(`close:${id}`);
          if (options.closeResource) {
            await options.closeResource();
          } else {
            live = false;
          }
        },
        inspect: () => options.inspect?.() ?? (live ? 'live' : 'closed'),
      });
      await options.start?.(_context.signal);
      return `${id}-ready`;
    },
    async stop() {
      options.calls?.push(`stop:${id}`);
      if (options.stop) {
        await options.stop();
      } else {
        live = false;
      }
    },
    forceClose: options.forceClose
      ? async () => {
          options.calls?.push(`force:${id}`);
          await options.forceClose?.();
          live = false;
        }
      : undefined,
    async verifyStopped() {
      return { state: options.verify?.() ?? (live ? 'live' : 'stopped') };
    },
  };
}

function runtime(
  components: readonly RuntimeComponent[],
  options: { stopTimeoutMs?: number } = {},
) {
  return new BackendRuntime({
    components,
    generation: 'generation-test',
    stopTimeoutMs: options.stopTimeoutMs,
    createCapabilities: (ready) => ({ ready }),
  });
}

describe('BackendRuntime startup', () => {
  it('shares one in-flight start and rejects every later start', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn(() => gate);
    const backend = runtime([fakeComponent('core', { start })]);

    const first = backend.start();
    const concurrent = backend.start();
    expect(concurrent).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ phase: 'ready' });
    expect(start).toHaveBeenCalledOnce();
    await expect(backend.start()).rejects.toBeInstanceOf(BackendLifecycleError);

    await backend.stop('test-complete');
    await expect(backend.start()).rejects.toBeInstanceOf(BackendLifecycleError);
  });

  it('rolls a required failure back in reverse dependency order', async () => {
    const calls: string[] = [];
    const backend = runtime([
      fakeComponent('storage', { calls }),
      fakeComponent('agent', {
        calls,
        dependsOn: ['storage'],
        start: () => { throw new Error('agent failed'); },
      }),
    ]);

    const failure = await backend.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackendStartError);
    expect((failure as BackendStartError).report.phase).toBe('failed-start');
    expect((failure as BackendStartError).report.residualResources).toEqual([]);
    expect(calls.indexOf('stop:agent')).toBeLessThan(calls.indexOf('stop:storage'));
    expect(backend.snapshot().phase).toBe('failed-start');
    await expect(backend.start()).rejects.toBeInstanceOf(BackendLifecycleError);
  });

  it('continues in degraded-ready only after an optional failure is clean', async () => {
    const backend = runtime([
      fakeComponent('core'),
      fakeComponent('watcher', {
        requirement: 'optional',
        start: () => { throw new Error('watch unavailable'); },
      }),
    ]);

    const report = await backend.start();
    expect(report.phase).toBe('ready');
    expect(report.degradedCapabilities).toEqual([{
      componentId: 'watcher',
      reason: { name: 'Error', message: 'watch unavailable' },
    }]);
    expect(backend.snapshot().phase).toBe('ready');
    await expect(backend.stop('test-complete')).resolves.toMatchObject({ phase: 'stopped' });
  });

  it('quarantines an optional failure that leaves a live resource', async () => {
    const backend = runtime([
      fakeComponent('watcher', {
        requirement: 'optional',
        start: () => { throw new Error('partial watcher'); },
        stop: () => undefined,
        closeResource: () => undefined,
        inspect: () => 'live',
        verify: () => 'live',
      }),
    ]);

    const failure = await backend.start().catch((error: unknown) => error) as BackendStartError;
    expect(failure).toBeInstanceOf(BackendStartError);
    expect(failure.report.phase).toBe('quarantined');
    expect(failure.report.residualResources).toHaveLength(1);
  });

  it('quarantines a required rollback when verification is unknown', async () => {
    const backend = runtime([
      fakeComponent('core', {
        start: () => { throw new Error('failed after acquisition'); },
        inspect: () => 'unknown',
        verify: () => 'unknown',
      }),
    ]);

    const failure = await backend.start().catch((error: unknown) => error) as BackendStartError;
    expect(failure.report.phase).toBe('quarantined');
    expect(backend.snapshot().phase).toBe('quarantined');
  });

  it('does not stop a clean optional failure twice when a later required component fails', async () => {
    const optionalStop = vi.fn();
    const backend = runtime([
      fakeComponent('watcher', {
        requirement: 'optional',
        start: () => { throw new Error('watch unavailable'); },
        stop: optionalStop,
      }),
      fakeComponent('core', {
        start: () => { throw new Error('core unavailable'); },
      }),
    ]);

    await expect(backend.start()).rejects.toBeInstanceOf(BackendStartError);
    expect(optionalStop).toHaveBeenCalledOnce();
  });

  it('aborts same-layer starters immediately and waits for all of them before rollback', async () => {
    let siblingObservedAbort = false;
    const backend = runtime([
      fakeComponent('waiting-sibling', {
        start: (signal) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            siblingObservedAbort = true;
            reject(new Error('sibling aborted'));
          }, { once: true });
        }),
      }),
      fakeComponent('failing-sibling', {
        start: () => { throw new Error('required start failed'); },
      }),
    ]);

    const failure = await backend.start().catch((error: unknown) => error) as BackendStartError;
    expect(failure).toBeInstanceOf(BackendStartError);
    expect(siblingObservedAbort).toBe(true);
    expect(failure.report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentId: 'waiting-sibling', outcome: 'failed' }),
      expect.objectContaining({ componentId: 'failing-sibling', outcome: 'failed' }),
    ]));
    expect(failure.report.phase).toBe('failed-start');
  });

  it('rolls concurrent starters back in reverse completion order', async () => {
    const calls: string[] = [];
    const backend = runtime([
      fakeComponent('slow', {
        calls,
        start: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      }),
      fakeComponent('fast', { calls }),
      fakeComponent('fatal', {
        calls,
        dependsOn: ['slow', 'fast'],
        start: () => { throw new Error('later layer failed'); },
      }),
    ]);

    await expect(backend.start()).rejects.toBeInstanceOf(BackendStartError);
    expect(calls.filter((call) => call.startsWith('stop:'))).toEqual([
      'stop:fatal',
      'stop:slow',
      'stop:fast',
    ]);
  });

  it('treats a live resource in an optional child scope as fatal contamination', async () => {
    const optional: RuntimeComponent = {
      id: 'nested-watcher',
      requirement: 'optional',
      dependsOn: [],
      async start(_context, scope) {
        scope.child('watch').register({
          kind: 'file-watcher',
          label: 'nested-live-watcher',
          close: () => undefined,
          inspect: () => 'live',
        });
        throw new Error('watch setup failed');
      },
      async stop() {},
      async verifyStopped() { return { state: 'stopped' }; },
    };
    const backend = runtime([optional]);

    const failure = await backend.start().catch((error: unknown) => error) as BackendStartError;
    expect(failure.report.phase).toBe('quarantined');
    expect(failure.report.residualResources).toEqual([
      expect.objectContaining({ owner: 'component:nested-watcher/watch' }),
    ]);
  });

  it('coalesces quit requests received during startup into one clean rollback', async () => {
    const stop = vi.fn();
    const backend = runtime([
      fakeComponent('core', {
        start: (signal) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('startup cancelled')), { once: true });
        }),
        stop,
      }),
    ]);
    const start = backend.start();
    const startOutcome = start.catch((error: unknown) => error);
    await Promise.resolve();

    const firstQuit = backend.stop('quit');
    const secondQuit = backend.stop('signal');
    expect(secondQuit).toBe(firstQuit);
    await expect(firstQuit).rejects.toBeInstanceOf(BackendStartError);
    expect(await startOutcome).toBeInstanceOf(BackendStartError);
    expect(stop).toHaveBeenCalledOnce();
    expect(backend.snapshot().phase).toBe('failed-start');
  });
});

describe('BackendRuntime shutdown', () => {
  it('stops in reverse order and reaches stopped only after empty verification', async () => {
    const calls: string[] = [];
    const backend = runtime([
      fakeComponent('storage', { calls }),
      fakeComponent('agent', { calls, dependsOn: ['storage'] }),
      fakeComponent('im', { calls, dependsOn: ['agent'] }),
    ]);
    await backend.start();

    const report = await backend.stop('quit');
    expect(report.phase).toBe('stopped');
    expect(report.residualResources).toEqual([]);
    expect(calls.filter((call) => call.startsWith('stop:'))).toEqual([
      'stop:im',
      'stop:agent',
      'stop:storage',
    ]);
    await expect(backend.stop('again')).rejects.toBeInstanceOf(BackendLifecycleError);
  });

  it('continues after a stop error and reports failed-stop even when resources are gone', async () => {
    const calls: string[] = [];
    const backend = runtime([
      fakeComponent('storage', { calls }),
      fakeComponent('agent', {
        calls,
        dependsOn: ['storage'],
        stop: () => { throw new Error('agent stop failed'); },
        inspect: () => 'closed',
        verify: () => 'stopped',
      }),
    ]);
    await backend.start();

    const report = await backend.stop('quit');
    expect(report.phase).toBe('failed-stop');
    expect(calls).toContain('stop:storage');
    expect(report.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentId: 'agent', outcome: 'failed' }),
      expect.objectContaining({ componentId: 'storage', outcome: 'stopped' }),
    ]));
    await expect(backend.start()).rejects.toBeInstanceOf(BackendLifecycleError);
  });

  it('uses forceClose after a deadline but still reports failed-stop', async () => {
    let forced = false;
    const backend = runtime([
      fakeComponent('pilot', {
        stopTimeoutMs: 5,
        stop: () => new Promise<void>(() => undefined),
        forceClose: () => { forced = true; },
        inspect: () => forced ? 'closed' : 'live',
        verify: () => forced ? 'stopped' : 'live',
      }),
    ], { stopTimeoutMs: 5 });
    await backend.start();

    const report = await backend.stop('quit');
    expect(forced).toBe(true);
    expect(report.phase).toBe('failed-stop');
    expect(report.components[0]).toMatchObject({ outcome: 'timed-out' });
  });

  it('enters quarantine when a resource remains live after every close attempt', async () => {
    const backend = runtime([
      fakeComponent('pilot', {
        stop: () => undefined,
        closeResource: () => undefined,
        inspect: () => 'live',
        verify: () => 'live',
      }),
    ]);
    await backend.start();

    const report = await backend.stop('quit');
    expect(report.phase).toBe('quarantined');
    expect(report.residualResources).toHaveLength(1);
    await expect(backend.stop('again')).rejects.toBeInstanceOf(BackendLifecycleError);
  });

  it('shares one in-flight shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stop = vi.fn(() => gate);
    const backend = runtime([fakeComponent('core', { stop })]);
    await backend.start();

    const first = backend.stop('first');
    const concurrent = backend.stop('second');
    expect(concurrent).toBe(first);
    release();
    await first;
    expect(stop).toHaveBeenCalledOnce();
  });

  it('records every stop failure while continuing through the dependency graph', async () => {
    const calls: string[] = [];
    const backend = runtime([
      fakeComponent('storage', {
        calls,
        stop: () => { throw new Error('storage close failed'); },
        inspect: () => 'closed',
        verify: () => 'stopped',
      }),
      fakeComponent('agent', {
        calls,
        dependsOn: ['storage'],
        stop: () => { throw new Error('agent close failed'); },
        inspect: () => 'closed',
        verify: () => 'stopped',
      }),
    ]);
    await backend.start();

    const report = await backend.stop('quit');
    expect(report.phase).toBe('failed-stop');
    expect(report.components.filter(({ outcome }) => outcome === 'failed')).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('stop:'))).toEqual([
      'stop:agent',
      'stop:storage',
    ]);
  });
});
