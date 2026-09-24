import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingConnectionState } from '../../../../shared/electron-contracts/messaging';
import { useMessagingStore } from '../../../store/messagingStore';
import { MessagingHealthCue } from '../MessagingHealthCue';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let status: ReturnType<typeof vi.fn>;
const open = vi.fn();

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  status = vi.fn();
  Object.assign(window, { piskie: { runtime: { host: 'electron' }, messaging: { status } } });
  useMessagingStore.getState().clearError();
  useMessagingStore.setState({ connections: [], isLoadingConnections: false });
  open.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useMessagingStore.getState().clearError();
  container.remove();
  dom.window.close();
  vi.unstubAllGlobals();
});

async function showCue() {
  await act(async () => root.render(createElement(MessagingHealthCue, { onOpen: open })));
}

const bot = (id: string, runtimeStatus: MessagingConnectionState['status']): MessagingConnectionState => ({
  config: { id, name: 'Example Bot', channelType: 'feishu', definitionId: 'task-1' },
  status: runtimeStatus,
});

describe('IM global health cue', () => {
  it('points to setup before the messaging page has ever been opened', async () => {
    status.mockResolvedValue({ configs: [], botStates: [] });
    await showCue();
    const cue = container.querySelector('button');
    expect(status).toHaveBeenCalledTimes(1);
    expect(cue?.textContent).toContain('未配置 Bot');
    expect(cue?.title).toContain('选择消息渠道、绑定任务模板并保存 Bot，启动后才能接收消息');
    await act(async () => cue?.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows the started count and keeps other statuses in the tooltip', async () => {
    const saved = [bot('bot-1', 'stopped'), bot('bot-2', 'error'), bot('bot-3', 'running')];
    status.mockResolvedValue({ configs: saved.map(({ config }) => config), botStates: saved });
    await showCue();
    expect(container.querySelector('button')?.textContent).toBe('1 个 Bot 已启动');
    expect(container.querySelector('button')?.title).toContain('1 个 Bot 未启动 · 1 个 Bot 连接异常');
    expect(container.querySelector('button')?.title).toContain('保存配置不等于启动');
    await act(async () => useMessagingStore.setState({ connections: saved.map(({ config }) => ({ config, status: 'running' })) }));
    expect(container.querySelector('button')?.textContent).toBe('3 个 Bot 已启动');
    expect(container.querySelector('button')?.title).toContain('已启动的 Bot 可以接收消息');
  });

  it('keeps the running count compact and names stopped bots when none is running', async () => {
    const saved = [bot('bot-1', 'stopped'), bot('bot-2', 'stopped'), bot('bot-3', 'running')];
    status.mockResolvedValue({ configs: saved.map(({ config }) => config), botStates: saved });
    await showCue();
    expect(container.querySelector('button')?.textContent).toBe('1 个 Bot 已启动');
    expect(container.querySelector('button')?.title).toContain('2 个 Bot 未启动');
    await act(async () => useMessagingStore.setState({ connections: saved.slice(0, 2) }));
    expect(container.querySelector('button')?.textContent).toBe('2 个 Bot 未启动');
    expect(container.textContent).not.toContain('未上线');
  });

  it('does not mistake a failed status read for an empty configuration', async () => {
    status.mockRejectedValue(new Error('status unavailable'));
    await showCue();
    expect(container.querySelector('button')).toBeNull();
  });
});
