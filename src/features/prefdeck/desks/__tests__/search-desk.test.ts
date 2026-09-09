import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchDesk } from '../SearchDesk';
import { CatalogPane } from '../../CatalogPane';
import { useWebSearchStore } from '../../../../store/webSearchStore';
import { useProxyStore } from '../../../../store/proxyStore';
import type { SearchOperationResult } from '../../../../../shared/electron-contracts/web-search';
import i18n from 'i18next';
import '../../../../i18n';

let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
let root: Root;
let container: HTMLDivElement;
const checkConnection = vi.fn();
const cancelOperation = vi.fn(async () => undefined);

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('zh-CN');
  checkConnection.mockReset();
  cancelOperation.mockClear();
  Object.assign(window, { piskie: { webSearch: { checkConnection, cancelOperation } } });
  useWebSearchStore.setState({ config: { revision: 1, enabled: true, defaultProvider: 'parallel', providers: {
    parallel: { displayName: 'Parallel', enabled: true, authentication: 'anonymous' },
  } }, presets: [{ id: 'parallel', label: 'Parallel', authentication: [{ kind: 'anonymous' }],
    defaults: { authentication: 'anonymous', options: {} }, optionsSchema: {}, connectionCheck: true, oauth: { connected: false } }],
  isApplying: false, connecting: {} });
  useProxyStore.setState({ config: { proxies: [] } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

afterEach(async () => { await act(() => root.unmount()); container.remove(); });

async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  expect(button).toBeDefined();
  await act(() => button!.click());
}

describe('search settings presentation', () => {
  it('places tools between models and network and keeps browsing separate from current selection', async () => {
    const onProvider = vi.fn();
    await act(() => root.render(createElement(CatalogPane, {
      sect: 'web-search', providers: { ai: [], image: [] }, picked: { ai: null, image: null },
      searchProviders: [{ id: 'parallel', title: 'Parallel', active: true }, { id: 'exa', title: 'Exa', active: false }],
      pickedSearch: 'parallel', onSect: vi.fn(), onProvider: vi.fn(), onAddProvider: vi.fn(),
      onSearchProvider: onProvider, onAddSearchProvider: vi.fn(),
    })));
    const content = container.textContent!;
    expect(content.indexOf('模型')).toBeLessThan(content.indexOf('工具'));
    expect(content.indexOf('工具')).toBeLessThan(content.indexOf('网络'));
    await click('Exa');
    expect(onProvider).toHaveBeenCalledWith('exa');
    expect(useWebSearchStore.getState().config?.defaultProvider).toBe('parallel');
  });

  it('labels a late test result as stale after settings change', async () => {
    const result = deferred<SearchOperationResult<void>>();
    checkConnection.mockReturnValue(result.promise);
    await act(() => root.render(createElement(SearchDesk, { providerId: 'parallel', sessionId: 'sample-session', onFlash: vi.fn() })));
    await click('测试连接');
    expect(checkConnection).toHaveBeenCalledWith('parallel', expect.objectContaining({ revision: 1, sessionId: 'sample-session' }));
    await act(() => useWebSearchStore.setState({ config: { ...useWebSearchStore.getState().config!, revision: 2 } }));
    await act(async () => result.resolve({ ok: true, value: undefined }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('配置已改变');
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain('连接成功');
    checkConnection.mockResolvedValue({ ok: true });
    await click('测试连接');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('连接成功');
  });

  it('honors cancellation while waiting for pending settings saves', async () => {
    const saved = deferred<void>();
    const previous = useWebSearchStore.getState().waitForSaves;
    useWebSearchStore.setState({ waitForSaves: () => saved.promise });
    try {
      await act(() => root.render(createElement(SearchDesk, { providerId: 'parallel', sessionId: 'sample-session', onFlash: vi.fn() })));
      await click('测试连接');
      await click('取消');
      await act(() => saved.resolve());
      expect(checkConnection).not.toHaveBeenCalled();
      expect(container.querySelector('[role="status"]')?.textContent).toContain('已取消');
    } finally { useWebSearchStore.setState({ waitForSaves: previous }); }
  });

  it('cancels a pending settings test when leaving its detail page', async () => {
    checkConnection.mockReturnValue(new Promise(() => undefined));
    await act(() => root.render(createElement(SearchDesk, { providerId: 'parallel', sessionId: 'sample-session', onFlash: vi.fn() })));
    await click('测试连接');
    const id = checkConnection.mock.calls[0]?.[1].operationId;
    await act(() => root.render(null));
    expect(cancelOperation).toHaveBeenCalledWith(id);
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
