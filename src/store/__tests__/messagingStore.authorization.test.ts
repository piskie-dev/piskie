import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthorizedUser,
  SenderAuthorizationRequest,
} from '../../../shared/types/im-gateway';
import type { MessagingClient, MessagingConnectionChangedEvent } from '../../../shared/electron-contracts/messaging';

let useMessagingStore: typeof import('../messagingStore').useMessagingStore;

const approve = vi.fn();
const addAuthorizedUser = vi.fn();
const removeAuthorizedUser = vi.fn();
const authorizedUsers = vi.fn();
const saveBot = vi.fn();
const startBot = vi.fn();
const logoutAccount = vi.fn();
const status = vi.fn();
const stopBot = vi.fn();
const deleteBot = vi.fn();
const statusCleanup = vi.fn();
const authorizationCleanup = vi.fn();
const observeStatus = vi.fn((_listener: (event: MessagingConnectionChangedEvent) => void) => statusCleanup);
const observeAuthorization = vi.fn(() => authorizationCleanup);

const request: SenderAuthorizationRequest = {
  id: 'pair-1',
  botId: 'bot-1',
  botName: '客服',
  channel: 'wecom',
  senderId: 'user-1',
  senderName: '小王',
  pairingCode: 'ABC234',
  peerType: 'dm',
  peerId: 'user-1',
  createdAt: '2026-08-22T00:00:00.000Z',
  status: 'pending',
};

const user: AuthorizedUser = {
  botId: request.botId,
  senderId: request.senderId,
  senderName: request.senderName,
  approvedAt: '2026-08-22T00:01:00.000Z',
};

beforeAll(async () => {
  vi.stubGlobal('window', {
    piskie: {
      runtime: { host: 'electron' },
      messaging: {
        approve,
        addAuthorizedUser,
        removeAuthorizedUser,
        authorizedUsers,
        saveBot,
        startBot,
        logoutAccount,
        status,
        stopBot,
        deleteBot,
        observeStatus,
        observeAuthorization,
      },
    },
  });
  ({ useMessagingStore } = await import('../messagingStore'));
});

beforeEach(() => {
  approve.mockReset();
  addAuthorizedUser.mockReset();
  removeAuthorizedUser.mockReset();
  authorizedUsers.mockReset();
  saveBot.mockReset();
  startBot.mockReset();
  logoutAccount.mockReset();
  status.mockReset();
  stopBot.mockReset();
  deleteBot.mockReset();
  statusCleanup.mockReset();
  authorizationCleanup.mockReset();
  observeStatus.mockReset().mockReturnValue(statusCleanup);
  observeAuthorization.mockReset().mockReturnValue(authorizationCleanup);
  useMessagingStore.setState({
    connections: [],
    isLoadingConnections: false,
    senderAuthorizationRequests: [],
    authorizedUsers: [],
    error: null,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const botConfig = { id: 'bot-1', name: 'Bot', channelType: 'feishu', appId: 'app-1' };
type StatusSnapshot = Awaited<ReturnType<MessagingClient['status']>>;
function snapshot(state: 'running' | 'stopped' = 'running'): StatusSnapshot {
  return { configs: [botConfig], botStates: [{ config: botConfig, status: state }] };
}

describe('messagingStore concurrent status reads', () => {
  it.each([false, true])('refreshes a confirmed account after startup fails, read fails=%s', async (fails) => {
    startBot.mockRejectedValueOnce(new Error('Connector failed to start'));
    const loggedIn = { ...botConfig, pluginAccountId: 'confirmed-account' };
    if (fails) status.mockRejectedValueOnce(new Error('Refresh unavailable'));
    else status.mockResolvedValueOnce({ configs: [loggedIn], botStates: [] });
    await expect(useMessagingStore.getState().startConnection(botConfig.id)).resolves.toBe(false);
    expect(status).toHaveBeenCalledOnce();
    if (!fails) expect(useMessagingStore.getState().connections[0]?.config.pluginAccountId).toBe('confirmed-account');
    expect(useMessagingStore.getState().error).toBe('Error: Connector failed to start');
    useMessagingStore.getState().clearError();
  });

  it.each(['startConnection', 'logoutAccount'] as const)('keeps an acknowledged %s result when its follow-up refresh fails', async (action) => {
    status.mockRejectedValueOnce(new Error('Refresh unavailable'));
    await expect(useMessagingStore.getState()[action](botConfig.id)).resolves.toBe(true);
    expect(useMessagingStore.getState().error).toBe('Error: Refresh unavailable');
    useMessagingStore.getState().clearError();
  });

  it.each([false, true])('distinguishes a saved write from a failed refresh with cached=%s', async (cached) => {
    if (cached) useMessagingStore.setState({ connections: snapshot().botStates });
    saveBot.mockResolvedValueOnce(undefined);
    status.mockRejectedValueOnce(new Error('Refresh unavailable'));
    await expect(useMessagingStore.getState().saveConnection(botConfig)).resolves.toEqual({
      kind: 'saved-refresh-failed', botId: botConfig.id, error: 'Error: Refresh unavailable',
    });
    expect(saveBot).toHaveBeenCalledWith(botConfig);
    expect(useMessagingStore.getState().connections).toEqual(cached ? snapshot().botStates : []);
  });

  it('returns the accepted snapshot after saving instead of relying on the old cache', async () => {
    useMessagingStore.setState({ connections: snapshot().botStates });
    const saved = { ...botConfig, name: 'Saved name' };
    status.mockResolvedValueOnce({ configs: [saved], botStates: [] });
    await expect(useMessagingStore.getState().saveConnection(saved)).resolves.toEqual({
      kind: 'saved-refreshed', botId: botConfig.id, snapshot: [{ config: saved, status: 'stopped' }],
    });
  });

  it('reports an unconfirmed write without starting a status refresh', async () => {
    saveBot.mockRejectedValueOnce(new Error('Write rejected'));
    await expect(useMessagingStore.getState().saveConnection(botConfig)).resolves.toEqual({
      kind: 'write-unconfirmed', botId: botConfig.id, error: 'Error: Write rejected',
    });
    expect(status).not.toHaveBeenCalled();
    expect(useMessagingStore.getState().error).toBe('Error: Write rejected');
    useMessagingStore.getState().clearError();
  });

  it.each([
    ['error', true], ['stopped', true], ['stop_failed', true], ['error', false],
  ] as const)('preserves a newer %s event while loaded=%s and still refreshes configuration', async (nextStatus, loaded) => {
    if (loaded) useMessagingStore.setState({ connections: [{ config: botConfig, status: 'running' }] });
    let report!: (event: MessagingConnectionChangedEvent) => void;
    observeStatus.mockImplementationOnce((listener) => { report = listener; return statusCleanup; });
    const cleanup = useMessagingStore.getState().subscribeMessagingEvents();
    const response = deferred<StatusSnapshot>();
    status.mockReturnValueOnce(response.promise);
    const refresh = useMessagingStore.getState().fetchConnections();
    const error = nextStatus === 'stopped' ? undefined : 'New failure';
    report({ botId: botConfig.id, state: {
      config: { ...botConfig, name: 'Old runtime config' }, status: nextStatus, error,
    } });
    const other = { ...botConfig, id: 'bot-2' };
    response.resolve({ configs: [{ ...botConfig, name: 'Saved name' }, other], botStates: [
      { config: botConfig, status: 'running', error: 'Old failure' },
      { config: other, status: 'running' },
    ] });
    const refreshed = await refresh;
    expect(refreshed).toEqual({ kind: 'refreshed', snapshot: useMessagingStore.getState().connections });
    expect(useMessagingStore.getState().connections).toEqual([
      { config: { ...botConfig, name: 'Saved name' }, status: nextStatus, error },
      { config: other, status: 'running' },
    ]);
    // 下一次主动查询仍可更新状态，不能永久锁在缓存事件上。
    status.mockResolvedValueOnce(snapshot());
    await useMessagingStore.getState().fetchConnections();
    expect(useMessagingStore.getState().connections[0]?.status).toBe('running');
    cleanup();
  });

  it.each([true, false])('only accepts the latest query when older-first=%s', async (olderFirst) => {
    const older = deferred<StatusSnapshot>();
    const newer = deferred<StatusSnapshot>();
    status.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    let firstFinished = false;
    const first = useMessagingStore.getState().fetchConnections().then((result) => { firstFinished = true; return result; });
    const second = useMessagingStore.getState().fetchConnections();
    if (olderFirst) {
      older.resolve(snapshot());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(useMessagingStore.getState().connections).toEqual([]);
      expect(useMessagingStore.getState().isLoadingConnections).toBe(true);
      expect(firstFinished).toBe(false);
    }
    newer.resolve(snapshot('stopped'));
    const expected = { kind: 'refreshed', snapshot: snapshot('stopped').botStates };
    await expect(second).resolves.toEqual(expected);
    await expect(first).resolves.toEqual(expected);
    older.resolve(snapshot());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(useMessagingStore.getState().connections[0]?.status).toBe('stopped');
    expect(useMessagingStore.getState().isLoadingConnections).toBe(false);
  });

  it('keeps an outdated failure waiting through successive refreshes', async () => {
    const older = deferred<StatusSnapshot>();
    const middle = deferred<StatusSnapshot>();
    const latest = deferred<StatusSnapshot>();
    status.mockReturnValueOnce(older.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(latest.promise);
    let firstFinished = false;
    const first = useMessagingStore.getState().fetchConnections().then(() => { firstFinished = true; });
    const second = useMessagingStore.getState().fetchConnections();
    older.reject(new Error('Outdated failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedAfterFailure = firstFinished;
    const third = useMessagingStore.getState().fetchConnections();
    middle.resolve(snapshot());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedAfterMiddle = firstFinished;
    latest.resolve(snapshot('stopped'));
    await Promise.all([first, second, third]);
    expect(finishedAfterFailure).toBe(false);
    expect(finishedAfterMiddle).toBe(false);
    expect(useMessagingStore.getState().error).toBeNull();
    expect(useMessagingStore.getState().connections[0]?.status).toBe('stopped');
  });

  it('releases all callers on the latest failure and allows the next refresh to recover', async () => {
    const older = deferred<StatusSnapshot>();
    const latest = deferred<StatusSnapshot>();
    status.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    const first = useMessagingStore.getState().fetchConnections();
    const second = useMessagingStore.getState().fetchConnections();
    latest.reject(new Error('Current failure'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'refresh-failed', error: 'Error: Current failure' },
      { kind: 'refresh-failed', error: 'Error: Current failure' },
    ]);
    expect(useMessagingStore.getState().error).toBe('Error: Current failure');
    expect(useMessagingStore.getState().isLoadingConnections).toBe(false);
    useMessagingStore.getState().clearError();
    status.mockResolvedValueOnce(snapshot('stopped'));
    await useMessagingStore.getState().fetchConnections();
    older.resolve(snapshot());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(useMessagingStore.getState().connections[0]?.status).toBe('stopped');
    expect(useMessagingStore.getState().error).toBeNull();
  });

  it('does not report an outdated query failure after a newer query succeeded', async () => {
    const older = deferred<StatusSnapshot>();
    status.mockReturnValueOnce(older.promise).mockResolvedValueOnce(snapshot());
    const first = useMessagingStore.getState().fetchConnections();
    await useMessagingStore.getState().fetchConnections();
    older.reject(new Error('Old request failed'));
    await first;
    const current = useMessagingStore.getState();
    expect(current.error).toBeNull();
    expect(current.connections[0]?.status).toBe('running');
    current.clearError();
  });

  it.each(['stop', 'delete'])('preserves a successful %s while a status query is pending', async (action) => {
    useMessagingStore.setState({ connections: [{ config: botConfig, status: 'running' }] });
    const response = deferred<StatusSnapshot>();
    status.mockReturnValueOnce(response.promise);
    const refresh = useMessagingStore.getState().fetchConnections();
    if (action === 'stop') await useMessagingStore.getState().stopConnection(botConfig.id);
    else await useMessagingStore.getState().deleteConnection(botConfig.id);
    response.resolve(snapshot());
    await refresh;
    const bots = useMessagingStore.getState().connections;
    if (action === 'stop') expect(bots[0]?.status).toBe('stopped');
    else expect(bots).toEqual([]);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('messagingStore authorized users', () => {
  it('启动成功后保持主进程最终状态，不覆盖已经送达的 running 事件', async () => {
    const config = { id: 'bot-1', name: 'Bot', channelType: 'feishu', appId: 'app-1' };
    useMessagingStore.setState({ connections: [{ config, status: 'stopped' }] });
    let report!: (event: MessagingConnectionChangedEvent) => void;
    observeStatus.mockImplementationOnce((listener) => { report = listener; return statusCleanup; });
    const cleanup = useMessagingStore.getState().subscribeMessagingEvents();
    startBot.mockImplementationOnce(async () => {
      report({ botId: config.id, state: { config, status: 'running' } });
    });
    status.mockResolvedValue({ configs: [config], botStates: [{ config, status: 'running' }] });

    await expect(useMessagingStore.getState().startConnection(config.id)).resolves.toBe(true);
    expect(useMessagingStore.getState().connections[0]?.status).toBe('running');
    cleanup();
  });

  it('审批成功后移除待授权请求并刷新已授权用户', async () => {
    useMessagingStore.setState({ senderAuthorizationRequests: [request] });
    approve.mockResolvedValue(undefined);
    authorizedUsers.mockResolvedValue([user]);

    await expect(
      useMessagingStore.getState().approveSenderAuthorization(request.id),
    ).resolves.toBe(true);

    expect(approve).toHaveBeenCalledWith(request.id);
    expect(authorizedUsers).toHaveBeenCalledOnce();
    expect(useMessagingStore.getState().senderAuthorizationRequests).toEqual([]);
    expect(useMessagingStore.getState().authorizedUsers).toEqual([user]);
  });

  it('手工增删后都以主进程授权列表刷新 Store', async () => {
    addAuthorizedUser.mockResolvedValue(undefined);
    removeAuthorizedUser.mockResolvedValue(undefined);
    authorizedUsers.mockResolvedValueOnce([user]).mockResolvedValueOnce([]);

    await expect(
      useMessagingStore.getState().addAuthorizedUser(user.botId, user.senderId),
    ).resolves.toBe(true);
    expect(useMessagingStore.getState().authorizedUsers).toEqual([user]);

    await expect(
      useMessagingStore.getState().removeAuthorizedUser(user.botId, user.senderId),
    ).resolves.toBe(true);
    expect(useMessagingStore.getState().authorizedUsers).toEqual([]);
  });

  it('一次订阅注册两个 topic，并由同一个 cleanup 完整释放', () => {
    const cleanup = useMessagingStore.getState().subscribeMessagingEvents();

    expect(observeStatus).toHaveBeenCalledOnce();
    expect(observeAuthorization).toHaveBeenCalledOnce();

    cleanup();
    expect(statusCleanup).toHaveBeenCalledOnce();
    expect(authorizationCleanup).toHaveBeenCalledOnce();
  });
});
