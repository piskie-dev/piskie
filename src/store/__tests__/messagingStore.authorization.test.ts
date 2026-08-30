import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthorizedUser,
  SenderAuthorizationRequest,
} from '../../../shared/types/im-gateway';

let useMessagingStore: typeof import('../messagingStore').useMessagingStore;

const approve = vi.fn();
const addAuthorizedUser = vi.fn();
const removeAuthorizedUser = vi.fn();
const authorizedUsers = vi.fn();
const statusCleanup = vi.fn();
const authorizationCleanup = vi.fn();
const observeStatus = vi.fn(() => statusCleanup);
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
  statusCleanup.mockReset();
  authorizationCleanup.mockReset();
  observeStatus.mockReset().mockReturnValue(statusCleanup);
  observeAuthorization.mockReset().mockReturnValue(authorizationCleanup);
  useMessagingStore.setState({
    senderAuthorizationRequests: [],
    authorizedUsers: [],
    error: null,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('messagingStore authorized users', () => {
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
