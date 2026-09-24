/**
 * 会话浏览器控件：主会话三种触发器读数、面板分段与使用情况、待发送切换、
 * Worker 跳转、只读配置详情，以及浏览器 Worker 的只读读数。
 */
const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEnvironment } from '../../../../../../shared/types';
import type { Occupancy } from '../../../../../../shared/types/occupancy';
import { useBrowserEnvironmentStore } from '../../../../../store/browserEnvironmentStore';
import { useOccupancyStore } from '../../../../../store/occupancyStore';
import { resolveEnvironmentUsage } from '../../../../../utils/browserEnvironmentPresentation';
import { SessionBrowserControl, type SessionBrowserControlProps } from '../SessionBrowserControl';

vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) => createElement(React.Fragment, null, trigger, children),
}));

const identityPolicy: BrowserEnvironment['identityPolicy'] = {
  platform: 'windows',
  timezone: { mode: 'custom', value: 'Asia/Tokyo' },
  geolocation: { mode: 'off' },
  language: { mode: 'ip' },
};
const environments: BrowserEnvironment[] = [
  { id: 'environment-a', name: 'Sample shop', purpose: 'Sample purchasing', status: 'running', identityPolicy, proxyId: 'proxy-a', userDataId: 'data-a' },
  { id: 'environment-b', name: 'Sample forum', purpose: 'Sample posting', status: 'idle', identityPolicy },
  { id: 'environment-c', name: 'Sample mail', status: 'running', identityPolicy, userDataId: 'data-c' },
] as BrowserEnvironment[];
const occupancies: Occupancy[] = [
  { key: 'browserEnvironment:data-a', kind: 'browserEnvironment', resourceId: 'data-a', occupantId: 'worker-shop', ownerId: 'session-example', occupantName: 'Shop worker', since: '2026-09-01T00:00:00.000Z' },
  { key: 'browserEnvironment:data-c', kind: 'browserEnvironment', resourceId: 'data-c', occupantId: 'session-other', ownerId: 'session-other', occupantName: 'Other session', since: '2026-09-01T00:00:00.000Z' },
];
const workers = [{ id: 'worker-shop', subject: 'Buy the sample item', type: 'browser-worker', status: 'running' as const }];

let root: Root;
let container: HTMLDivElement;
const onPendingChange = vi.fn();
const onOpenWorker = vi.fn();
const proxyRead = vi.fn().mockResolvedValue({ proxies: [{ id: 'proxy-a', name: 'Sample proxy', protocol: 'socks5' }] });

async function render(props: SessionBrowserControlProps) {
  await act(async () => root.render(createElement(SessionBrowserControl, props)));
}
const trigger = () => container.querySelector<HTMLElement>('[data-testid="session-browser-control"]')!;
const rows = (section: string) => [...container.querySelectorAll<HTMLElement>(`[data-section="${section}"]`)];
const click = async (element: HTMLElement) => act(async () => element.click());
const session = (overrides: Partial<Extract<SessionBrowserControlProps, { mode: 'session' }>> = {}): SessionBrowserControlProps => ({
  mode: 'session', agentId: 'session-example', joinedIds: ['environment-a'], pendingIds: [], workers,
  onPendingChange, onOpenWorker, ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    runtime: { host: 'web' },
    observability: { occupancy: { list: vi.fn().mockResolvedValue(occupancies) } },
    configuration: { proxy: { read: proxyRead } },
  } });
  useBrowserEnvironmentStore.setState({ environments, isLoading: false, error: null });
  useOccupancyStore.setState({ occupancies });
  onPendingChange.mockReset();
  onOpenWorker.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
afterAll(async () => (await testDOM).window.close());

describe('resolveEnvironmentUsage', () => {
  it('reads usage from the occupancy registry rather than the running status', () => {
    expect(resolveEnvironmentUsage(environments[0]!, occupancies, 'session-example', workers))
      .toEqual({ kind: 'worker', workerId: 'worker-shop', label: 'Buy the sample item' });
    expect(resolveEnvironmentUsage(environments[1]!, occupancies, 'session-example', workers)).toEqual({ kind: 'idle' });
    expect(resolveEnvironmentUsage(environments[2]!, occupancies, 'session-example', workers))
      .toEqual({ kind: 'external', label: 'Other session' });
    expect(resolveEnvironmentUsage({ id: 'environment-a', userDataId: 'data-a' }, occupancies, 'session-example', []))
      .toEqual({ kind: 'worker', workerId: 'worker-shop', label: 'Shop worker' });
  });
});

describe('session browser control', () => {
  it('labels the trigger by the size of the current set', async () => {
    await render(session({ joinedIds: [] }));
    expect(trigger().textContent).toBe('选择浏览器…');
    await render(session({ joinedIds: ['environment-a'] }));
    expect(trigger().textContent).toBe('Sample shop');
    await render(session({ joinedIds: ['environment-a', 'environment-b'] }));
    expect(trigger().textContent).toBe('2 个浏览器');
    await render(session({ joinedIds: ['environment-missing'] }));
    expect(trigger().textContent).toBe('environment-missing');
    // 新建会话页：没有已加入集合，选中后提示继续添加
    await render(session({ agentId: undefined, joinedIds: [], pendingIds: ['environment-b'], workers: undefined }));
    expect(trigger().textContent).toBe('添加');
    expect(trigger().dataset.pending).toBe('true');
  });

  it('treats every occupancy as external before a session exists', async () => {
    await render(session({ agentId: undefined, joinedIds: [], workers: undefined }));
    await click(trigger());
    expect(rows('joined')).toHaveLength(0);
    expect(rows('available')[0]!.textContent).toContain('Shop worker 使用中');
    expect(container.querySelector('[data-worker-id]')).toBeNull();
  });

  it('lists the current session with usage and the rest as addable, toggling pending selections', async () => {
    await render(session({ pendingIds: ['environment-b'] }));
    await click(trigger());
    expect(rows('joined').map((row) => row.textContent)).toEqual(['Sample shopSample purchasingBuy the sample item 使用中']);
    expect(rows('available').map((row) => row.querySelector('[class*="rowName"]')!.textContent)).toEqual(['Sample forum', 'Sample mail']);
    expect(rows('available')[0]!.textContent).toContain('待发送');
    expect(rows('available')[1]!.textContent).toContain('Other session 使用中');

    await click(rows('available')[1]!.querySelector<HTMLElement>('[class*="rowMain"]')!);
    expect(onPendingChange).toHaveBeenLastCalledWith(['environment-b', 'environment-c']);
    await click(rows('available')[0]!.querySelector<HTMLElement>('[class*="toggle"]')!);
    expect(onPendingChange).toHaveBeenLastCalledWith([]);
  });

  it('jumps to the Worker using an environment and opens read-only details from the name', async () => {
    await render(session());
    await click(trigger());
    await click(container.querySelector<HTMLElement>('[data-worker-id="worker-shop"]')!);
    expect(onOpenWorker).toHaveBeenCalledWith('worker-shop');

    await click(trigger());
    await click(rows('joined')[0]!.querySelector<HTMLElement>('[class*="rowMain"]')!);
    const details = container.querySelector('[data-testid="session-browser-details"]')!;
    expect(details.textContent).toContain('Sample shop');
    expect(details.textContent).toContain('Sample purchasing');
    await act(async () => { await proxyRead.mock.results[0]?.value; });
    const facts = [...details.querySelectorAll('dd')].map((node) => node.textContent);
    expect(facts).toEqual(['Sample purchasing', 'Sample proxy · SOCKS5', 'Asia/Tokyo · 语言随 IP · Windows', '关闭']);
    expect(details.querySelector('input')).toBeNull();

    await click(details.querySelector<HTMLElement>('[class*="back"]')!);
    expect(container.querySelector('[data-testid="session-browser-details"]')).toBeNull();
    expect(rows('joined')).toHaveLength(1);
  });

  it('filters by name, purpose or usage and reports empty states', async () => {
    await render(session());
    await click(trigger());
    const search = container.querySelector<HTMLInputElement>('input')!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('posting');
    expect(rows('joined')).toHaveLength(0);
    expect(rows('available').map((row) => row.querySelector('[class*="rowName"]')!.textContent)).toEqual(['Sample forum']);
    await type('other session');
    expect(rows('available').map((row) => row.querySelector('[class*="rowName"]')!.textContent)).toEqual(['Sample mail']);
    await type('nothing here');
    expect(container.querySelector('[role="status"]')!.textContent).toBe('没有匹配的浏览器环境');

    await type('');
    await render(session({ joinedIds: ['environment-a', 'environment-b', 'environment-c'] }));
    expect(rows('joined')).toHaveLength(3);
    expect(container.querySelector('[role="status"]')!.textContent).toBe('所有浏览器环境都已加入当前会话');
  });

  it('shows a browser Worker its bound environment or the temporary browser, read-only', async () => {
    await render({ mode: 'worker', environmentId: 'environment-b' });
    expect(trigger().tagName).toBe('SPAN');
    expect(trigger().textContent).toBe('Sample forum');
    expect(trigger().getAttribute('title')).toBe('浏览器 Worker 的绑定不可修改');
    await render({ mode: 'worker' });
    expect(trigger().textContent).toBe('临时浏览器');
    expect(container.querySelector('input')).toBeNull();
  });
});
