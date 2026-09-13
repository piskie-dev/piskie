import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { Simulate } from 'react-dom/test-utils';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessagingStore } from '../../../../src/store/messagingStore';
import type { MessagingClient, MessagingConnectionConfig } from '../../../../shared/electron-contracts/messaging';
import { MessagingApplication } from '../messaging-application.js';
import { ConfigHost } from '../../../config/host/config-host.js';
import { ConfigDomainRegistry } from '../../../config/core/registry.js';
import { createImBotsDomain } from '../../../config/domains/im-bots.adapter.js';
import type { PiskieDesktopApi } from '../../../../shared/electron-contracts/api';
import * as runtimeModule from '../../../../src/renderer-runtime/renderer-runtime';
import { createRendererRuntime } from '../../../../src/renderer-runtime/createRendererRuntime';

const initialStore = useMessagingStore.getState();

const state = vi.hoisted(() => ({
  connectorDescriptors: [], senderAuthorizationRequests: [], authorizedUsers: [],
  connections: [{ config: { id: 'bot-1', name: 'Bot', channelType: 'openclaw-weixin',
    appId: '', pluginAccountId: 'account-1', definitionId: 'definition-1' }, status: 'running' as const }],
  stopConnection: vi.fn(), logoutAccount: vi.fn(), fetchAuthorizedUsers: vi.fn(),
}));
const qr = vi.hoisted(() => vi.fn((_props: { onConnected: (already: boolean) => void }) => null));
const guide = vi.hoisted(() => vi.fn((_props: { ready: boolean }) => null));
const runtime = vi.hoisted(() => ({ taskDefinitions: { refresh: vi.fn(async () => undefined) } }));
const templates = vi.hoisted(() => [
  { definitionId: 'td-first', name: 'First template', purpose: 'messaging' },
  { definitionId: 'td-second', name: 'Second template', purpose: 'messaging' },
]);
vi.mock('../../../../src/renderer-runtime/hooks', () => ({
  useTaskDefinitionRepository: () => templates, useRendererRuntime: () => runtime,
}));
vi.mock('../../../../src/features/guides/AutoGuide', () => ({ AutoGuide: guide }));
vi.mock('../../../../src/components/task-definition/TaskDefinitionModal', () => ({ TaskDefinitionModal: () => null }));
vi.mock('../../../../src/features/imdossier/WeixinQrFlow', () => ({ WeixinQrFlow: qr }));
import { DossierPane, type DossierFocus } from '../../../../src/features/imdossier/DossierPane';
import { ImDossierPage } from '../../../../src/features/imdossier/ImDossierPage';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const temporaryDirectories: string[] = [];
const pendingRequests = new Set<Promise<unknown>>();
const releaseDeferred: Array<() => void> = [];
function track<T>(request: Promise<T>): Promise<T> {
  pendingRequests.add(request);
  void request.then(() => pendingRequests.delete(request), () => pendingRequests.delete(request));
  return request;
}
async function finishRequests() {
  do {
    await Promise.allSettled([...pendingRequests]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (pendingRequests.size > 0);
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: vi.fn() });
  useMessagingStore.setState({ ...initialStore, ...state });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    for (const release of releaseDeferred.splice(0)) release();
    await finishRequests();
  });
  await act(async () => root.unmount());
  useMessagingStore.getState().clearError();
  dom.window.close();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

type Snapshot = Awaited<ReturnType<MessagingClient['status']>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  releaseDeferred.push(() => reject(new Error('Test cleanup')));
  return { promise, resolve, reject };
}

async function savedBotFixture(channel = 'openclaw-weixin') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-im-save-ui-'));
  temporaryDirectories.push(directory);
  const registry = new ConfigDomainRegistry();
  registry.register(createImBotsDomain(directory, { validate() {}, publish() {} }, async () => ({
    revision: 1,
    definitions: Object.fromEntries(templates.map((template) => [template.definitionId, template])),
  })));
  const host = new ConfigHost(registry);
  const application = new MessagingApplication({ config: host, gateway: { getBotStates: () => [] } as never });
  const saveBot = vi.fn((config: MessagingConnectionConfig) => application.saveBot(config));
  const status = vi.fn(() => application.status());
  Object.assign(dom.window, { piskie: { runtime: { host: 'electron' }, messaging: {
    saveBot: (config: MessagingConnectionConfig) => track(saveBot(config)), status: () => track(status()),
  } } });
  useMessagingStore.setState({ connections: [] });
  const onSaved = vi.fn();
  const onDismiss = vi.fn();
  const onFlash = vi.fn();
  function Editor() {
    const [focus, setFocus] = useState<DossierFocus | null>({ kind: 'draft', channelId: channel });
    return createElement(DossierPane, {
      key: focus?.kind === 'bot' ? focus.botId : 'draft', focus,
      pageGuide: { consoleURL: '', steps: [] }, onFlash, onDraft: vi.fn(),
      onSaved: (id: string) => { onSaved(id); setFocus({ kind: 'bot', botId: id }); },
      onDismiss: () => { onDismiss(); setFocus(null); },
    });
  }
  const render = async (key = 'first') => { await act(async () => root.render(createElement(Editor, { key }))); };
  await render();
  return { application, host, saveBot, status, onSaved, onDismiss, onFlash, render };
}

async function input(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`#${id}`)!;
  expect(element).not.toBeNull();
  await act(async () => { element.value = value; Simulate.change(element); });
}
async function pickTemplate(name = 'First template') {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click());
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((element) => element.textContent?.includes(name))!;
  expect(option.disabled).toBe(false);
  await act(async () => option.click());
}
async function fillDraft(channel = 'openclaw-weixin', template = 'First template') {
  await input('imd-name', 'New Bot');
  await pickTemplate(template);
  if (channel !== 'openclaw-weixin') {
    await input('imd-appid', 'app-1');
    await input('imd-secret', 'secret-1');
  }
}
function saveButton() {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === '保存')!;
}
async function save(waitForRefresh = true) {
  await act(async () => {
    saveButton().click();
    if (waitForRefresh) await finishRequests();
    else {
      await Promise.allSettled([...pendingRequests]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}

it.each(['refresh', 'write', 'lost-reply'] as const)('retries the same Bot after %s failure using the real form and persistence', async (failure) => {
  const f = await savedBotFixture();
  await fillDraft();
  if (failure === 'refresh') f.status.mockRejectedValueOnce(new Error('Refresh failed'));
  else f.saveBot.mockImplementationOnce(async (config) => {
    if (failure === 'lost-reply') await f.application.saveBot(config);
    throw new Error('Write response unavailable');
  });
  await save();
  const id = f.saveBot.mock.calls[0]![0].id;
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(saveButton().disabled).toBe(false);
  expect((await f.application.status()).configs).toHaveLength(failure === 'write' ? 0 : 1);
  // 真正修改表单后重试，既不能生成第二个 Bot，也不能忽略本次修改。
  await input('imd-name', 'Updated Bot');
  await save();
  expect(f.saveBot.mock.calls[1]![0].id).toBe(id);
  expect((await f.application.status()).configs).toMatchObject([{ id, name: 'Updated Bot', definitionId: 'td-first' }]);
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.onDismiss).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>('#imd-name')?.value).toBe('Updated Bot');
  expect(useMessagingStore.getState().error).toBeNull();
});

it.each([true, false])('waits for the latest refresh before opening the saved Bot, latest succeeds=%s', async (succeeds) => {
  const f = await savedBotFixture();
  await fillDraft();
  const first = deferred<Snapshot>();
  const later = deferred<Snapshot>();
  f.status.mockReturnValueOnce(first.promise).mockReturnValueOnce(later.promise);
  await save(false);
  const snapshot = await f.application.status();
  const refreshing = useMessagingStore.getState().fetchConnections();
  await act(async () => { first.resolve(snapshot); });
  expect(f.onSaved).not.toHaveBeenCalled();
  await act(async () => {
    if (succeeds) later.resolve(snapshot);
    else later.reject(new Error('Refresh failed'));
    await refreshing;
  });
  expect(f.onSaved).toHaveBeenCalledTimes(succeeds ? 1 : 0);
  expect(f.onDismiss).not.toHaveBeenCalled();
  expect(f.onFlash).toHaveBeenCalled(); // 写入成功与列表读取失败分别呈现。
});

it('preserves stored fields and its own template after a failed refresh recovers', async () => {
  const f = await savedBotFixture('feishu');
  await fillDraft('feishu');
  f.status.mockRejectedValueOnce(new Error('Refresh failed'));
  await save();
  const stored = (await f.application.status()).configs[0]!;
  await f.application.saveBot({ ...stored, allowFrom: ['kept-user'], replyForward: {
    forwardAssistantText: true, forwardToolCalls: false, forwardToolResults: false,
    toolFilter: { mode: 'include', tools: ['browser.click'] },
  } });
  await act(async () => useMessagingStore.getState().fetchConnections());
  await pickTemplate(); // 本草稿已保存的模板不能被误判为其他 Bot 占用。
  await input('imd-secret', '');
  await input('imd-name', 'Updated Bot');
  await save();
  expect((await f.application.status()).configs).toMatchObject([{
    id: stored.id, name: 'Updated Bot', appSecret: 'secret-1', allowFrom: ['kept-user'],
    replyForward: { toolFilter: { mode: 'include', tools: ['browser.click'] } },
  }]);
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith(stored.id);
});

it.each([false, true])('keeps the last saved credential when refresh fails and the secret is left blank, existing=%s', async (existing) => {
  const f = await savedBotFixture('feishu');
  await fillDraft('feishu');
  if (existing) await save();
  await input('imd-secret', 'updated-secret');
  f.status.mockRejectedValueOnce(new Error('Refresh failed after credential save'));
  await save();
  await input('imd-secret', '');
  await input('imd-name', 'Updated Bot');
  await save();
  expect((await f.application.status()).configs).toMatchObject([{
    name: 'Updated Bot', appSecret: 'updated-secret',
  }]);
});

it.each([false, true])('does not reopen a dismissed draft when its refresh fails=%s', async (fails) => {
  const f = await savedBotFixture();
  await fillDraft();
  const response = deferred<Snapshot>();
  f.status.mockReturnValueOnce(response.promise);
  await save(false);
  const snapshot = await f.application.status();
  const firstId = snapshot.configs[0]!.id;
  await f.render('second'); // 相当于页面切换焦点后重新挂载一份草稿。
  await act(async () => {
    if (fails) response.reject(new Error('Refresh failed after leaving'));
    else response.resolve(snapshot);
  });
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(f.onFlash).not.toHaveBeenCalled();
  await fillDraft('openclaw-weixin', 'Second template');
  await save();
  const secondId = f.saveBot.mock.calls[1]![0].id;
  expect(secondId).not.toBe(firstId);
  expect((await f.application.status()).configs).toHaveLength(2);
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith(secondId);
});

it.each([
  [false, false], [false, true], [true, false], [true, true],
])('keeps edits across repeated saves when refresh failures are first=%s, second=%s', async (firstFails, secondFails) => {
  const f = await savedBotFixture();
  await fillDraft();
  const response = deferred<Snapshot>();
  f.status.mockReturnValueOnce(response.promise);
  await save(false);
  const snapshot = await f.application.status();
  const id = snapshot.configs[0]!.id;
  await input('imd-name', 'Edited during save');
  await act(async () => {
    if (firstFails) response.reject(new Error('First refresh failed'));
    else response.resolve(snapshot);
  });
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>('#imd-name')?.value).toBe('Edited during save');
  if (secondFails) f.status.mockRejectedValueOnce(new Error('Second refresh failed'));
  await save();
  expect((await f.application.status()).configs).toMatchObject([{ id, name: 'Edited during save' }]);
  expect(container.querySelector<HTMLInputElement>('#imd-name')?.value).toBe('Edited during save');
  if (secondFails) {
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(f.onDismiss).not.toHaveBeenCalled();
    await save();
    expect((await f.application.status()).configs).toMatchObject([{ id, name: 'Edited during save' }]);
  }
  expect(f.onSaved).toHaveBeenCalledExactlyOnceWith(id);
});

it.each([false, true])('uses the initial read result for page readiness when it fails=%s', async (fails) => {
  const f = await savedBotFixture();
  await act(async () => {
    useMessagingStore.setState({
      error: 'Unrelated connector error',
      connectorDescriptors: [{ channelId: 'openclaw-weixin', displayName: '微信', packageName: 'weixin', version: 'test' }],
      fetchConnectorDescriptors: async () => undefined,
      fetchSenderAuthorizationRequests: async () => undefined,
    });
  });
  if (fails) f.status.mockRejectedValueOnce(new Error('Initial refresh failed'));
  await act(async () => root.render(createElement(ImDossierPage)));
  await act(async () => { await finishRequests(); });
  await act(async () => { useMessagingStore.getState().clearError(); });
  expect(guide.mock.calls.at(-1)![0].ready).toBe(!fails);
});

it('reports a configuration-notification refresh failure and processes the next notification', async () => {
  const f = await savedBotFixture();
  const config = { id: 'notification-bot', name: 'Notified Bot', channelType: 'openclaw-weixin', appId: '' };
  await f.application.saveBot(config);
  let notify!: Parameters<PiskieDesktopApi['configuration']['observeChanges']>[0];
  const record = vi.fn(async () => undefined);
  Object.assign(window.piskie, {
    configuration: { observeChanges: (listener: typeof notify) => { notify = listener; return () => {}; } },
    observability: {
      incidents: { observe: () => () => {} }, occupancy: { observe: () => () => {} }, clientLogs: { record },
    },
  });
  Object.assign(window.piskie.messaging, { observeStatus: () => () => {}, observeAuthorization: () => () => {} });
  let services!: runtimeModule.RendererRuntimeServices;
  const factory = vi.spyOn(runtimeModule, 'createRuntime').mockImplementation((_api, supplied) => {
    services = supplied;
    return {} as never;
  });
  const disposers: Array<() => void> = [];
  try {
    createRendererRuntime(window.piskie);
    services.startSubscriptions((dispose) => disposers.push(dispose), runtime as never);
    f.status.mockRejectedValueOnce(new Error('Notification refresh failed'));
    await act(async () => {
      notify({ domain: 'im-bots', revision: 1, descriptorHash: 'test', source: 'apply' });
      await finishRequests();
    });
    expect(record).toHaveBeenCalledExactlyOnceWith({
      event: 'config.domain.refresh.failed', context: { domain: 'im-bots' },
    });
    await act(async () => {
      notify({ domain: 'im-bots', revision: 2, descriptorHash: 'test', source: 'apply' });
      await finishRequests();
    });
    expect(f.status).toHaveBeenCalledTimes(2);
    expect(useMessagingStore.getState().connections).toMatchObject([{ config }]);
    expect(record).toHaveBeenCalledTimes(1);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    factory.mockRestore();
  }
});

it('dismisses a draft confirmed removed after saving instead of allowing it to be recreated', async () => {
  const f = await savedBotFixture();
  await fillDraft();
  f.status.mockImplementationOnce(async () => {
    const id = (await f.application.status()).configs[0]!.id;
    await f.application.deleteBot(id);
    return f.application.status();
  });
  await save();
  expect(f.onSaved).not.toHaveBeenCalled();
  expect(f.onDismiss).toHaveBeenCalledOnce();
  expect(container.querySelector('#imd-name')).toBeNull();
  expect((await f.application.status()).configs).toEqual([]);
});

describe('Weixin account changes require a completed stop', () => {
  it('starts a confirmed login through the start action without waiting for a redundant read', async () => {
    const startConnection = vi.fn(async () => true);
    const fetchConnections = vi.fn(async () => ({ kind: 'refresh-failed' as const, error: 'Unavailable' }));
    useMessagingStore.setState({ startConnection, fetchConnections });
    state.stopConnection.mockResolvedValue(true);
    await act(async () => root.render(createElement(DossierPane, {
      focus: { kind: 'bot', botId: 'bot-1' }, pageGuide: { consoleURL: '', steps: [] },
      onFlash: vi.fn(), onDismiss: vi.fn(), onSaved: vi.fn(), onDraft: vi.fn(),
    })));
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === '重新扫码')!;
    await act(async () => button.click());
    await act(async () => qr.mock.calls.at(-1)![0].onConnected(false));
    expect(startConnection).toHaveBeenCalledExactlyOnceWith('bot-1');
    expect(fetchConnections).not.toHaveBeenCalled();
  });

  it.each([
    ['重新扫码', false], ['退出账号', false], ['重新扫码', true], ['退出账号', true],
  ] as const)('%s proceeds only when stop succeeds: %s', async (label, stopSucceeded) => {
    state.stopConnection.mockResolvedValue(stopSucceeded);
    await act(async () => root.render(createElement(DossierPane, {
      focus: { kind: 'bot', botId: 'bot-1' }, pageGuide: { consoleURL: '', steps: [] },
      onFlash: vi.fn(), onDismiss: vi.fn(), onSaved: vi.fn(), onDraft: vi.fn(),
    })));
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(state.stopConnection).toHaveBeenCalledWith('bot-1');
    expect(qr).toHaveBeenCalledTimes(stopSucceeded && label === '重新扫码' ? 1 : 0);
    expect(state.logoutAccount).toHaveBeenCalledTimes(stopSucceeded && label === '退出账号' ? 1 : 0);
  });
});
