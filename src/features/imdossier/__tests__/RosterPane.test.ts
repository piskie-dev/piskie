import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MessagingConnectionState } from '../../../../shared/electron-contracts/messaging';

const state = vi.hoisted(() => ({
  connectorDescriptors: [],
  connections: [{ config: { id: 'orphan', name: 'Saved Bot', channelType: 'missing-channel' }, status: 'stopped' }] as MessagingConnectionState[],
  senderAuthorizationRequests: [], isLoadingConnectors: false, isLoadingConnections: false,
  fetchConnectorDescriptors: vi.fn(), fetchConnections: vi.fn(),
}));
vi.mock('../../../store/messagingStore', () => ({
  useMessagingStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('../../../renderer-runtime/hooks', () => ({
  useTaskDefinitionRepository: () => [],
}));
vi.mock('../HandbookPopover', () => ({ HandbookPopover: () => null }));
vi.mock('../PendingPopover', () => ({ PendingPopover: () => null }));
import { RosterPane } from '../RosterPane';

describe('IM roster when the connector catalog is unavailable', () => {
  it.each([false, true])('keeps saved Bots reachable while loading=%s', (isLoading) => {
    state.isLoadingConnectors = isLoading;
    const html = renderToStaticMarkup(createElement(RosterPane, {
      pickedBotId: null, onPick: vi.fn(), onDraft: vi.fn(),
      pageGuide: { consoleURL: '', steps: [] },
    }));
    expect(html).toContain('Saved Bot');
    expect(html).toContain('role="button"');
  });

  it('shows each bot\'s actual reason for not receiving messages in its row', () => {
    state.isLoadingConnectors = false;
    state.connections = [
      { config: { id: 'bot-1', name: 'Unbound Bot', channelType: 'feishu' }, status: 'stopped' },
      { config: { id: 'bot-2', name: 'Signed-out Bot', channelType: 'openclaw-weixin', definitionId: 'task-1' }, status: 'stopped' },
      { config: { id: 'bot-3', name: 'Saved Bot', channelType: 'feishu', definitionId: 'task-2' }, status: 'stopped' },
      { config: { id: 'bot-4', name: 'Faulty Bot', channelType: 'feishu', definitionId: 'task-3' }, status: 'error' },
      { config: { id: 'bot-5', name: 'Online Bot', channelType: 'feishu', definitionId: 'task-4' }, status: 'running' },
    ];
    const html = renderToStaticMarkup(createElement(RosterPane, {
      pickedBotId: null, onPick: vi.fn(), onDraft: vi.fn(),
      pageGuide: { consoleURL: '', steps: [] },
    }));

    for (const label of [
      '未启动 · 先绑定任务模板', '未启动 · 先扫码登录', '未启动 · 点击启动后才能收消息',
      '连接异常 · 查看详情并重试',
    ]) expect(html).toContain(label);
    expect(html).toContain('消息在线');
    expect(html.match(/class="[^"]*entryGuidance/g)?.length).toBe(4);
  });
});
