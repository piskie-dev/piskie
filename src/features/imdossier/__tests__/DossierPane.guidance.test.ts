import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingConnectionState } from '../../../../shared/electron-contracts/messaging';
import { messageText } from '../../../i18n/presentationText';

const state = vi.hoisted(() => ({
  connections: [] as MessagingConnectionState[],
  connectorDescriptors: [], senderAuthorizationRequests: [], authorizedUsers: [],
  saveConnection: vi.fn(), fetchAuthorizedUsers: vi.fn(),
}));
vi.mock('../../../store/messagingStore', () => ({
  useMessagingStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('../../../renderer-runtime/hooks', () => ({
  useTaskDefinitionRepository: (select: (value: { definitions: never[] }) => unknown) => select({ definitions: [] }),
}));
vi.mock('../../../components/task-definition/TaskDefinitionModal', () => ({ TaskDefinitionModal: () => null }));
vi.mock('../../console/chrome/Dialog', () => ({ Dialog: () => null }));
vi.mock('../TemplateDropdown', () => ({ TemplateDropdown: () => null }));
vi.mock('../HandbookPopover', () => ({ GuideSteps: () => null, ChannelGuideFold: () => null }));
import { DossierPane } from '../DossierPane';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
const onFlash = vi.fn();

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onFlash.mockClear();
  state.fetchAuthorizedUsers.mockReset().mockResolvedValue(undefined);
  state.saveConnection.mockReset().mockImplementation(async () => ({
    kind: 'saved-refreshed', botId: 'bot-1', snapshot: state.connections,
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dom.window.close();
  vi.unstubAllGlobals();
});

async function renderBot(bot: MessagingConnectionState) {
  state.connections = [bot];
  await act(async () => root.render(createElement(DossierPane, {
    focus: { kind: 'bot', botId: 'bot-1' },
    pageGuide: { consoleURL: '', steps: [] },
    onFlash, onDismiss: vi.fn(), onSaved: vi.fn(), onDraft: vi.fn(),
  })));
}

const bot = (status: MessagingConnectionState['status'], channelType = 'feishu'): MessagingConnectionState => ({
  config: {
    id: 'bot-1', name: 'Example Bot', channelType, definitionId: 'task-1',
    appId: 'example-id', appSecret: 'example-secret',
  },
  status,
});

describe('IM dossier runtime guidance', () => {
  it('shows a persistent warning and save feedback that explicitly says to start a saved bot', async () => {
    await renderBot(bot('stopped'));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Bot 尚未启动，无法接收消息；点击「启动」上线。');
    expect(container.textContent).toContain('保存只更新配置');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '保存')?.click());
    expect(onFlash).toHaveBeenCalledWith(messageText('imPlugin.dossier.savedNeedsStart'), 'hold');
  });

  it('prompts QR sign-in, not the manual start action, for a saved signed-out bot', async () => {
    await renderBot(bot('stopped', 'openclaw-weixin'));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('先扫码登录');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '保存')?.click());
    expect(onFlash).toHaveBeenCalledWith(messageText('imPlugin.dossier.savedNeedsSignIn'), 'hold');
  });

  it('preserves the running bot restart notice and exposes runtime faults', async () => {
    await renderBot(bot('running'));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '保存')?.click());
    expect(onFlash).toHaveBeenCalledWith(messageText('imPlugin.dossier.savedRestartNotice'), 'hold');

    await renderBot({ ...bot('error'), error: 'connection failed' });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('当前无法接收消息');
    expect(container.textContent).toContain('connection failed');

    await renderBot({
      config: { id: 'bot-1', name: 'Example Bot', channelType: 'feishu' },
      status: 'error', error: 'template unavailable',
    });
    expect(container.textContent).toContain('template unavailable');
  });
});
