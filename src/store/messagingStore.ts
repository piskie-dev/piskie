/**
 * Messaging Store
 * 管理消息连接器、连接配置和发送者授权状态。
 */

import { create } from 'zustand';
import type {
  MessagingConnectorDescriptor,
  SenderAuthorizationRequest,
  AuthorizedUser,
  QrLoginStartResult,
  QrLoginSubmitCodeResult,
  QrLoginWaitResult,
} from '../../shared/types/im-gateway';
import type {
  MessagingConnectionState,
  MessagingConnectionConfig,
  MessagingConnectionChangedEvent,
  SaveMessagingConnectionRequest,
} from '../../shared/electron-contracts/messaging';

export type ConnectionsRefreshResult =
  | { kind: 'refreshed'; snapshot: readonly MessagingConnectionState[] }
  | { kind: 'refresh-failed'; error: string };

export type SaveConnectionResult =
  | { kind: 'write-unconfirmed'; botId: string; error: string }
  | { kind: 'saved-refresh-failed'; botId: string; error: string }
  | { kind: 'saved-refreshed'; botId: string; snapshot: readonly MessagingConnectionState[] };

const DESKTOP_UNAVAILABLE = 'Desktop messaging is unavailable';

// 检查是否在 Electron 环境中
const isElectron = () => typeof window !== 'undefined' && window.piskie?.runtime.host === 'electron';

// 错误自动清除定时器
let errorTimerId: ReturnType<typeof setTimeout> | null = null;

// 只保留最新查询期间的变更；null 表示已删除，防止旧快照恢复该 Bot。
let pendingConnectionUpdates: Map<string, MessagingConnectionState | null> | null = null;
// 重叠查询的调用方一起等待最新查询落地，不能因自己的旧响应被丢弃就提前继续。
let connectionRefreshWaiters: Array<(result: ConnectionsRefreshResult) => void> = [];

/** 设置 error 并在 timeout 毫秒后自动清除 */
function setErrorWithAutoClear(set: (partial: Partial<MessagingState>) => void, error: string, timeout = 20000) {
  if (errorTimerId) clearTimeout(errorTimerId);
  set({ error });
  errorTimerId = setTimeout(() => {
    set({ error: null });
    errorTimerId = null;
  }, timeout);
}

interface MessagingState {
  // Data
  connectorDescriptors: MessagingConnectorDescriptor[];
  connections: MessagingConnectionState[];
  senderAuthorizationRequests: SenderAuthorizationRequest[];
  authorizedUsers: AuthorizedUser[];

  // Loading states
  isLoadingConnectors: boolean;
  isLoadingConnections: boolean;

  // Error
  error: string | null;

  // Install progress

  // Actions - Connector catalog
  fetchConnectorDescriptors: () => Promise<void>;

  // Actions - Connection lifecycle
  fetchConnections: () => Promise<ConnectionsRefreshResult>;
  // 统一编排写入与同步，调用方依据完整结果决定提示和页面迁移。
  saveConnection: (config: SaveMessagingConnectionRequest) => Promise<SaveConnectionResult>;
  deleteConnection: (connectionId: string) => Promise<boolean>;
  startConnection: (connectionId: string) => Promise<boolean>;
  stopConnection: (connectionId: string) => Promise<boolean>;

  // Actions - Sender authorization
  fetchSenderAuthorizationRequests: () => Promise<void>;
  approveSenderAuthorization: (requestId: string) => Promise<boolean>;
  rejectSenderAuthorization: (requestId: string) => Promise<boolean>;
  fetchAuthorizedUsers: () => Promise<void>;
  addAuthorizedUser: (connectionId: string, userId: string) => Promise<boolean>;
  removeAuthorizedUser: (connectionId: string, userId: string) => Promise<boolean>;

  // Actions - QR 登录 / 登出
  loginWithQrStart: (
    connectionId: string,
    channelType: string,
    force?: boolean,
  ) => Promise<QrLoginStartResult | null>;
  loginWithQrWait: (connectionId: string, channelType: string) => Promise<QrLoginWaitResult | null>;
  loginWithQrSubmitCode: (
    connectionId: string,
    channelType: string,
    code: string,
  ) => Promise<QrLoginSubmitCodeResult | null>;
  loginWithQrCancel: (connectionId: string, channelType: string) => Promise<boolean>;
  logoutAccount: (connectionId: string) => Promise<boolean>;

  // Actions - 事件监听
  subscribeMessagingEvents: () => () => void;

  // Actions - 通用
  clearError: () => void;
}

export const useMessagingStore = create<MessagingState>((set, get) => ({
  // 初始状态
  connectorDescriptors: [],
  connections: [],
  senderAuthorizationRequests: [],
  authorizedUsers: [],
  isLoadingConnectors: false,
  isLoadingConnections: false,
  error: null,

  // ============================================================
  // Connector catalog
  // ============================================================

  fetchConnectorDescriptors: async () => {
    if (!isElectron()) return;
    set({ isLoadingConnectors: true });
    try {
      set({ connectorDescriptors: await window.piskie.messaging.listConnectors() });
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
    } finally {
      set({ isLoadingConnectors: false });
    }
  },
  // ============================================================
  // Connection lifecycle
  // ============================================================

  fetchConnections: () => {
    if (!isElectron()) return Promise.resolve({ kind: 'refresh-failed', error: DESKTOP_UNAVAILABLE });
    const finished = new Promise<ConnectionsRefreshResult>((resolve) => { connectionRefreshWaiters.push(resolve); });
    const updates = new Map<string, MessagingConnectionState | null>();
    pendingConnectionUpdates = updates;
    set({ isLoadingConnections: true });
    void (async () => {
      let result: ConnectionsRefreshResult | undefined;
      try {
        const { botStates, configs } = await window.piskie.messaging.status();
        if (pendingConnectionUpdates !== updates) return;
        const stateMap = new Map<string, MessagingConnectionState>();
        for (const state of botStates) {
          if (state.config?.id) stateMap.set(state.config.id, state);
        }
        // Runtime snapshots may hold stale credentials, so merge only their status fields
        // onto the canonical persisted connection config returned by the same operation.
        // 查询响应可能晚于状态事件到达，期间收到的状态优先于快照。
        const merged: MessagingConnectionState[] = configs
          .filter((config) => updates.get(config.id) !== null)
          .map((config: MessagingConnectionConfig) => {
            const runtime = updates.get(config.id) ?? stateMap.get(config.id);
            return runtime ? { ...runtime, config } : { config, status: 'stopped' as const };
          });
        result = { kind: 'refreshed', snapshot: merged };
        set({ connections: merged });
      } catch (error) {
        result = { kind: 'refresh-failed', error: String(error) };
        if (pendingConnectionUpdates === updates) setErrorWithAutoClear(set, result.error);
      } finally {
        if (pendingConnectionUpdates === updates && result) {
          const waiters = connectionRefreshWaiters;
          connectionRefreshWaiters = [];
          pendingConnectionUpdates = null;
          set({ isLoadingConnections: false });
          for (const resolve of waiters) resolve(result);
        }
      }
    })();
    return finished;
  },

  saveConnection: async (config) => {
    const botId = config.id;
    if (!isElectron()) return { kind: 'write-unconfirmed', botId, error: DESKTOP_UNAVAILABLE };
    get().clearError();
    try {
      await window.piskie.messaging.saveBot(config);
    } catch (error) {
      const message = String(error);
      setErrorWithAutoClear(set, message);
      // 响应丢失也可能发生在落盘之后，失败时不能断言配置未写入。
      return { kind: 'write-unconfirmed', botId, error: message };
    }
    const refreshed = await get().fetchConnections();
    return refreshed.kind === 'refreshed'
      ? { kind: 'saved-refreshed', botId, snapshot: refreshed.snapshot }
      : { kind: 'saved-refresh-failed', botId, error: refreshed.error };
  },

  deleteConnection: async (connectionId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.deleteBot(connectionId);
      pendingConnectionUpdates?.set(connectionId, null);
      set((prev) => ({
        connections: prev.connections.filter((connection) => connection.config.id !== connectionId),
      }));
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  startConnection: async (connectionId) => {
    if (!isElectron()) return false;
    let failure: string | null = null;
    try {
      await window.piskie.messaging.startBot(connectionId);
    } catch (error) {
      failure = String(error);
    }
    // 扫码已成功时，即使启动失败也要同步账号；查询结果不改变命令结果。
    await get().fetchConnections();
    if (failure !== null) {
      setErrorWithAutoClear(set, failure);
      return false;
    }
    return true;
  },

  stopConnection: async (connectionId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.stopBot(connectionId);
      set((prev) => ({
        connections: prev.connections.map((connection) => {
          if (connection.config.id !== connectionId) return connection;
          const stopped = { ...connection, status: 'stopped' as const, error: undefined };
          pendingConnectionUpdates?.set(connectionId, stopped);
          return stopped;
        }),
      }));
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  // ============================================================
  // 授权管理
  // ============================================================

  fetchSenderAuthorizationRequests: async () => {
    if (!isElectron()) return;
    try {
      set({ senderAuthorizationRequests: await window.piskie.messaging.pendingAuthorization() });
    } catch (error) {
      console.error('Failed to fetch sender authorization requests:', error);
    }
  },

  approveSenderAuthorization: async (requestId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.approve(requestId);
      set((prev) => ({
        senderAuthorizationRequests: prev.senderAuthorizationRequests.filter(
          (request) => request.id !== requestId,
        ),
      }));
      await get().fetchAuthorizedUsers();
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  rejectSenderAuthorization: async (requestId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.reject(requestId);
      set((prev) => ({
        senderAuthorizationRequests: prev.senderAuthorizationRequests.filter(
          (request) => request.id !== requestId,
        ),
      }));
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  fetchAuthorizedUsers: async () => {
    if (!isElectron()) return;
    try {
      set({ authorizedUsers: await window.piskie.messaging.authorizedUsers() });
    } catch (error) {
      console.error('Failed to fetch authorized users:', error);
    }
  },

  addAuthorizedUser: async (connectionId, userId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.addAuthorizedUser(connectionId, userId);
      await get().fetchAuthorizedUsers();
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  removeAuthorizedUser: async (connectionId, userId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.removeAuthorizedUser(connectionId, userId);
      await get().fetchAuthorizedUsers();
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  // ============================================================
  // QR 登录 / 登出
  // ============================================================

  loginWithQrStart: async (connectionId, channelType, force) => {
    if (!isElectron()) return null;
    try {
      return await window.piskie.messaging.startQrLogin(connectionId, channelType, force);
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return null;
    }
  },

  loginWithQrWait: async (connectionId, channelType) => {
    if (!isElectron()) return null;
    try {
      return await window.piskie.messaging.waitForQrLogin(connectionId, channelType);
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return null;
    }
  },

  loginWithQrSubmitCode: async (connectionId, channelType, code) => {
    if (!isElectron()) return null;
    try {
      return await window.piskie.messaging.submitQrCode(connectionId, channelType, code);
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return null;
    }
  },

  loginWithQrCancel: async (connectionId, channelType) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.cancelQrLogin(connectionId, channelType);
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  logoutAccount: async (connectionId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.logoutAccount(connectionId);
      // 同步失败不代表账号退出被回滚。
      await get().fetchConnections();
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  // ============================================================
  // 事件监听
  // ============================================================

  subscribeMessagingEvents: () => {
    if (!isElectron()) return () => {};

    // 监听连接运行状态变更
    const unsubStatus = window.piskie.messaging.observeStatus(
      (event: MessagingConnectionChangedEvent) => {
        if (pendingConnectionUpdates?.get(event.botId) !== null) {
          pendingConnectionUpdates?.set(event.botId, event.state);
        }
        // 双快照分离：状态事件只更新运行状态字段，config 保持
        // 列表中已加载的持久配置——事件携带的是启动快照 config，不能回写覆盖
        set((prev) => ({
          connections: prev.connections.map((connection) =>
            connection.config.id === event.botId
              ? { ...event.state, config: connection.config }
              : connection
          ),
        }));
      }
    );

    // 监听新授权请求
    const unsubAuth = window.piskie.messaging.observeAuthorization(
      (request: SenderAuthorizationRequest) => {
        // 授权事件可能与首次清单读取交错，按 id 保持幂等。
        set((prev) => ({
          senderAuthorizationRequests: prev.senderAuthorizationRequests.some(
            (existing) => existing.id === request.id,
          )
            ? prev.senderAuthorizationRequests
            : [...prev.senderAuthorizationRequests, request],
        }));
      }
    );

    // 返回清理函数
    return () => {
      unsubStatus();
      unsubAuth();
    };
  },

  // ============================================================
  // 通用
  // ============================================================

  clearError: () => {
    if (errorTimerId) {
      clearTimeout(errorTimerId);
      errorTimerId = null;
    }
    set({ error: null });
  },
}));
