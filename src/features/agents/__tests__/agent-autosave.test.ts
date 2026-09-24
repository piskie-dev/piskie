import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPreferencesDocument } from '../../../../shared/types/worker-preferences';
import type { ModelOptGroup } from '../../../store/inferenceStore';
import { applyConfigFieldChanges } from '../../config/config-transaction';
import { AgentManagementView } from '../AgentManagementView';
import { useWorkerPreferencesStore as store } from '../worker-preferences-store';
import '../../../i18n';

vi.mock('../../config/config-transaction', () => ({ applyConfigFieldChanges: vi.fn() }));

const target = { providerId: 'provider-a', modelId: 'model-a' };
const high = { mode: 'fixed', target, reasoning: { kind: 'effort', effort: 'high' } } as const;
const low = { mode: 'fixed', target, reasoning: { kind: 'effort', effort: 'low' } } as const;
const groups: ModelOptGroup[] = [{
  label: 'Provider A',
  options: [{
    value: 'provider-a::model-a', label: 'Model A', target,
    definition: { reasoning: {
      mode: 'effort',
      options: [{ kind: 'effort', effort: 'low' }, { kind: 'effort', effort: 'high' }],
    } },
  } as ModelOptGroup['options'][number]],
}];
let disk: WorkerPreferencesDocument;

function persist(
  revision: number,
  changes: Parameters<typeof applyConfigFieldChanges>[3]
): Awaited<ReturnType<typeof applyConfigFieldChanges>> {
  expect(revision).toBe(disk.revision);
  for (const change of changes) {
    const type = change.bindings!.type as string;
    if (change.pathTemplate.endsWith('/inference')) {
      if (change.op === 'remove') delete disk.profiles[type]!.inference;
      else disk.profiles[type] = { ...disk.profiles[type], inference: change.value as typeof disk.profiles[string]['inference'] };
    } else if (change.pathTemplate.endsWith('/displayName')) {
      if (change.op === 'remove') delete disk.profiles[type]!.displayName;
      else disk.profiles[type] = { ...disk.profiles[type], displayName: change.value as string };
    } else if (change.op === 'remove') delete disk.profiles[type];
    else disk.profiles[type] = change.value as typeof disk.profiles[string];
  }
  disk.revision++;
  return { receipt: { revision: disk.revision } } as Awaited<ReturnType<typeof applyConfigFieldChanges>>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.useFakeTimers();
  disk = {
    schemaVersion: 1,
    revision: 0,
    profiles: { 'alpha-worker': { inference: { target, reasoning: high.reasoning } } },
  };
  store.setState({
    document: null, descriptor: null, types: [], drafts: {}, selected: '', scrollPositions: {},
    loading: false, saving: null, loadError: null, saveErrors: {}, savedType: null,
  });
  vi.stubGlobal('window', {
    piskie: {
      configuration: {
        read: vi.fn(async () => structuredClone(disk)),
        describe: async () => ({ domain: 'worker-preferences' }),
      },
      agents: { listWorkerTypes: async () => [
        { type: 'alpha-worker', description: 'Alpha' },
        { type: 'beta-worker', description: 'Beta' },
      ] },
    },
  });
  vi.mocked(applyConfigFieldChanges).mockReset().mockImplementation(async (_domain, _descriptor, revision, changes) =>
    persist(revision, changes));
  await store.getState().refresh();
  store.getState().configureAutosave(groups, null);
});

afterEach(() => {
  store.setState({ drafts: {} });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Agent autosave', () => {
  it('retains edits entered while a configuration refresh is pending', async () => {
    const gate = deferred();
    const snapshot = structuredClone(disk);
    const read = vi.mocked(window.piskie.configuration.read);
    read.mockImplementationOnce(async () => {
      await gate.promise;
      return snapshot;
    });
    const refresh = store.getState().refresh();
    await Promise.resolve();
    store.getState().edit('alpha-worker', low);
    gate.resolve();
    await refresh;
    await vi.advanceTimersByTimeAsync(500);
    expect(disk.profiles['alpha-worker']?.inference?.reasoning).toEqual(low.reasoning);
    expect(store.getState().drafts['alpha-worker']).toBeUndefined();
  });

  it('debounces edits, saves each type after switching, and keeps model and reasoning together', async () => {
    store.getState().edit('alpha-worker', low);
    store.getState().edit('alpha-worker', high);
    store.getState().edit('alpha-worker', low);
    store.getState().select('beta-worker');
    store.getState().edit('beta-worker', high);
    await vi.advanceTimersByTimeAsync(349);
    expect(applyConfigFieldChanges).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.profiles['alpha-worker']?.inference?.reasoning).toEqual(low.reasoning);
    expect(disk.profiles['beta-worker']?.inference).toEqual({ target, reasoning: high.reasoning });
    expect(store.getState().selected).toBe('beta-worker');
    expect(store.getState().drafts).toEqual({});
    expect(applyConfigFieldChanges).toHaveBeenCalledTimes(2);
  });

  it('rebases newer input during a pending write, even when the last edit matches the old disk value', async () => {
    const gate = deferred();
    vi.mocked(applyConfigFieldChanges).mockImplementationOnce(async (_domain, _descriptor, revision, changes) => {
      await gate.promise;
      return persist(revision, changes);
    });
    store.getState().edit('alpha-worker', low);
    await vi.advanceTimersByTimeAsync(350);
    expect(store.getState().saving).toBe('alpha-worker');
    store.getState().edit('alpha-worker', high);
    expect(store.getState().drafts['alpha-worker']?.value).toEqual(high);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.profiles['alpha-worker']?.inference?.reasoning).toEqual(high.reasoning);
    expect(store.getState().drafts['alpha-worker']).toBeUndefined();
    expect(store.getState().saveErrors).toEqual({});
    expect(applyConfigFieldChanges).toHaveBeenCalledTimes(2);
  });

  it('waits for valid fixed selections and model availability but permits inheritance', async () => {
    store.getState().edit('beta-worker', { mode: 'fixed' });
    await vi.advanceTimersByTimeAsync(500);
    expect(applyConfigFieldChanges).not.toHaveBeenCalled();
    store.getState().edit('beta-worker', {
      ...high, reasoning: { kind: 'effort', effort: 'max' },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(applyConfigFieldChanges).not.toHaveBeenCalled();
    store.getState().configureAutosave(groups, 'Model list unavailable');
    store.getState().edit('beta-worker', high);
    await vi.advanceTimersByTimeAsync(500);
    expect(applyConfigFieldChanges).not.toHaveBeenCalled();
    store.getState().configureAutosave(groups, null);
    await vi.advanceTimersByTimeAsync(500);
    expect(disk.profiles['beta-worker']?.inference).toEqual({ target, reasoning: high.reasoning });
    store.getState().configureAutosave([], 'Model list unavailable');
    store.getState().edit('beta-worker', { mode: 'inherit' });
    await vi.advanceTimersByTimeAsync(500);
    expect(disk.profiles['beta-worker']).toBeUndefined();
  });

  it('saves a remark without rewriting an existing model that is temporarily unavailable', async () => {
    store.getState().configureAutosave([], 'Model list unavailable');
    store.getState().editDisplayName('alpha-worker', 'Example name');
    await vi.advanceTimersByTimeAsync(500);
    expect(disk.profiles['alpha-worker']).toEqual({
      displayName: 'Example name', inference: { target, reasoning: high.reasoning },
    });
  });

  it('keeps the failed draft and only retries on request or after another edit', async () => {
    vi.mocked(applyConfigFieldChanges).mockRejectedValueOnce(new Error('Write failed'));
    store.getState().editDisplayName('beta-worker', 'Example name');
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getState().saveErrors['beta-worker']).toBe('Write failed');
    expect(store.getState().drafts['beta-worker']?.displayName).toBe('Example name');
    await vi.advanceTimersByTimeAsync(2000);
    expect(applyConfigFieldChanges).toHaveBeenCalledTimes(1);
    await store.getState().save('beta-worker');
    expect(disk.profiles['beta-worker']).toEqual({ displayName: 'Example name' });
    expect(store.getState().saveErrors).toEqual({});
  });

  it('does not overwrite a concurrent external edit until the user resolves the conflict', async () => {
    store.getState().edit('alpha-worker', { mode: 'inherit' });
    disk.profiles['alpha-worker']!.inference!.reasoning = low.reasoning;
    disk.revision++;
    await vi.advanceTimersByTimeAsync(500);
    expect(applyConfigFieldChanges).not.toHaveBeenCalled();
    expect(store.getState().drafts['alpha-worker']?.conflict).toBe(true);
    store.getState().rebase('alpha-worker');
    await vi.advanceTimersByTimeAsync(500);
    expect(disk.profiles['alpha-worker']).toBeUndefined();
    expect(store.getState().drafts['alpha-worker']).toBeUndefined();
  });
});

it('shows save status but no footer actions, and offers retry only after a failure', async () => {
  vi.useRealTimers();
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = async () => act(async () => root.render(createElement(AgentManagementView, {
    ...store.getState(), groups, modelError: null,
    onConfigureModels: () => {}, onRefresh: () => {},
  })));
  try {
    await render();
    expect(container.querySelector('footer button')).toBeNull();
    store.setState({
      drafts: { 'alpha-worker': {
        base: disk.profiles['alpha-worker'], value: low, displayName: '', conflict: false,
      } },
      saveErrors: { 'alpha-worker': 'Write failed' },
    });
    await render();
    expect(container.querySelector('footer button')).toBeNull();
    expect(container.querySelector('[role="alert"] button')?.textContent).toMatch(/Retry|重试/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    dom.window.close();
  }
});
