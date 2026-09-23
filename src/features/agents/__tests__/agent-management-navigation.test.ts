import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useInferenceStore } from '../../../store/inferenceStore';
import { useWorkerPreferencesStore } from '../worker-preferences-store';
import { AgentManagementPage } from '../AgentManagementPage';
import '../../../i18n';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('opens Explore from settings without pinning later type navigation', async () => {
  const inference = useInferenceStore.getState();
  const workers = useWorkerPreferencesStore.getState();
  let pathname = '';
  function Route() {
    const location = useLocation();
    pathname = location.pathname + location.search;
    return createElement(AgentManagementPage);
  }
  try {
    useInferenceStore.setState({ refresh: async () => {}, config: null });
    useWorkerPreferencesStore.setState({
      refresh: async () => {},
      document: { schemaVersion: 1, revision: 1, profiles: {} },
      types: [
        { type: 'local-worker', description: 'General tasks' },
        { type: 'explore', description: 'Search files' },
      ],
      selected: 'local-worker',
      drafts: {},
      loading: false,
      saving: null,
      loadError: null,
    });
    await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/agents?type=explore'] }, createElement(Route))));
    expect(useWorkerPreferencesStore.getState().selected).toBe('explore');
    expect(pathname).toBe('/agents');
    await act(async () => useWorkerPreferencesStore.getState().select('local-worker'));
    expect(useWorkerPreferencesStore.getState().selected).toBe('local-worker');
  } finally {
    await act(async () => root.render(null));
    useInferenceStore.setState(inference, true);
    useWorkerPreferencesStore.setState(workers, true);
  }
});
