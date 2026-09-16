import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/features/console/attachments/__tests__/fixtures';
import CapabilityDetailPane from '../CapabilityDetailPane';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const writeText = vi.fn();
const openExternal = vi.fn();
const onFlash = vi.fn();
const noop = () => undefined;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'ShadowRoot'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(window, { piskie: { desktop: { system: { openExternal } } } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  writeText.mockReset().mockResolvedValue(undefined);
  openExternal.mockReset().mockResolvedValue(undefined);
  onFlash.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(sourceUrl: string) {
  await act(async () => root.render(createElement(CapabilityDetailPane, {
    entry: { id: 'sample', kind: 'skill', name: 'Sample capability', description: 'Sample description',
      sourceId: 'sample-source', sourceName: 'Sample source', sourceUrl, installSource: '/workspace/sample' },
    installed: null, locations: [], locationsLoading: false, stats: { market: 1, installed: 0, updates: 0 },
    busy: false, onInstall: noop, onProbe: noop, onUpdate: noop, onManageOwner: noop, onConfigureMcp: noop,
    mcpEditor: null, savingMcp: false, onSaveMcpConfig: async () => true, onCancelMcpEdit: noop,
    onToggleLocation: noop, onRemoveLocation: noop, onForkLocation: noop, onInstallElsewhere: noop,
    onSelectMember: noop, onNavigateView: noop, projects: [], onFlash,
  })));
}

describe('market source action', () => {
  it('waits for path copying, reports failures, and preserves the source action on retry', async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    await render('/workspace/sample source');
    const button = container.querySelector<HTMLButtonElement>(`button[title="${i18n.t('marketUi.detail.copySourcePath')}"]`)!;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith('/workspace/sample source');
    expect(onFlash).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error('denied')));
    expect(onFlash).toHaveBeenLastCalledWith({ kind: 'message', key: 'clipboardUi.copyFailed' });
    await act(async () => button.click());
    expect(onFlash).toHaveBeenLastCalledWith({ kind: 'message', key: 'marketUi.detail.sourcePathCopied' });
  });

  it('keeps web source links as external navigation', async () => {
    const url = 'https://example.test/sample';
    await render(url);
    await act(async () => container.querySelector<HTMLButtonElement>(`button[title="${i18n.t('marketUi.detail.openSourcePage')}"]`)!.click());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(writeText).not.toHaveBeenCalled();
  });
});
