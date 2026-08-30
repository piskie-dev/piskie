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

// 检查是否在 Electron 环境中
const isElectron = () => typeof window !== 'undefined' && window.piskie?.runtime.host === 'electron';

// 错误自动清除定时器
let errorTimerId: ReturnType<typeof setTimeout> | null = null;

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
  fetchConnections: () => Promise<void>;
  saveConnection: (config: SaveMessagingConnectionRequest) => Promise<boolean>;
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

  fetchConnections: async () => {
    if (!isElectron()) return;
    set({ isLoadingConnections: true });
    try {
      const { botStates, configs } = await window.piskie.messaging.status();
      const stateMap = new Map<string, MessagingConnectionState>();
      for (const state of botStates) {
        if (state.config?.id) stateMap.set(state.config.id, state);
      }
      // Runtime snapshots may hold stale credentials, so merge only their status fields
      // onto the canonical persisted connection config returned by the same operation.
      const merged: MessagingConnectionState[] = configs.map((config: MessagingConnectionConfig) => {
        const runtime = stateMap.get(config.id);
        return runtime ? { ...runtime, config } : { config, status: 'stopped' as const };
      });
      set({ connections: merged });
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
    } finally {
      set({ isLoadingConnections: false });
    }
  },

  saveConnection: async (config) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.saveBot(config);
      await get().fetchConnections();
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  deleteConnection: async (connectionId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.deleteBot(connectionId);
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
    try {
      await window.piskie.messaging.startBot(connectionId);
      set((prev) => ({
        connections: prev.connections.map((connection) =>
          connection.config.id === connectionId
            ? { ...connection, status: 'starting' as const }
            : connection
        ),
      }));
      return true;
    } catch (error) {
      setErrorWithAutoClear(set, String(error));
      return false;
    }
  },

  stopConnection: async (connectionId) => {
    if (!isElectron()) return false;
    try {
      await window.piskie.messaging.stopBot(connectionId);
      set((prev) => ({
        connections: prev.connections.map((connection) =>
          connection.config.id === connectionId
            ? { ...connection, status: 'stopped' as const, error: undefined }
            : connection
        ),
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
