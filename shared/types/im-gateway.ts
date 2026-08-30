/**
 * IM Gateway 共享类型定义
 * 前端和后端共用
 */

/** Bot 配置 - 存储在 PISKIE，部分传递给 OpenClaw 插件 */
export interface MessagingConnectionConfig {
  id: string;               // bot unique ID, also used as accountId
  channelType: string;      // plugin channel ID: 'feishu', 'wecom', etc.
  name: string;             // display name

  // PISKIE internal (not passed to plugin)
  definitionId?: string;
  replyForward?: IMReplyForwardConfig;

  // Application credentials are absent for account-login channels.
  appId?: string;
  appSecret?: string;
  pluginAccountId?: string;  // QR/login lifecycle observation; never written to im-bots config
  corpId?: string;           // WeChat Work extra
  agentId?: number;          // WeChat Work extra

  // Access control (passed to plugin, plugin executes checks)
  dmPolicy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom?: string[];
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom?: string[];
  groupSenderAllowFrom?: string[];
  requireMention?: boolean;
}

export type MessagingPeerKind = 'direct' | 'group';

/** A natural IM conversation bound to an existing AgentRun. */
export interface MessagingAgentBinding {
  peerKind: MessagingPeerKind;
  peerId: string;
  agentId: string;
}

export type MessagingAgentBindings = Record<string, MessagingAgentBinding[]>;

/** 回复转发配置（最终回复恒转发，不设开关） */
export interface IMReplyForwardConfig {
  forwardAssistantText: boolean;  // default: true
  forwardToolCalls: boolean;      // default: false
  forwardToolResults: boolean;    // default: false
  toolFilter?: {
    mode: 'include' | 'exclude';
    tools: string[];
  };
}

/** 待授权请求 */
export interface SenderAuthorizationRequest {
  id: string;
  botId: string;
  botName: string;
  channel: string;
  senderId: string;
  senderName?: string;
  pairingCode: string;
  peerType: 'dm' | 'group';
  peerId: string;
  createdAt: string;           // ISO timestamp
  status: 'pending' | 'approved' | 'rejected';
}

/** 创建待授权请求所需的渠道事实；其余字段由授权 Registry 生成。 */
export type SenderAuthorizationRequestInput = Omit<
  SenderAuthorizationRequest,
  'id' | 'pairingCode' | 'createdAt' | 'status'
>;

/** Bot 运行状态（stopping/stop_failed 为进程内停止 barrier 状态，不写入持久配置） */
export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'stop_failed' | 'error';

/** Bot 运行时状态（配置 + 状态） */
export interface BotState {
  config: MessagingConnectionConfig;
  status: BotStatus;
  error?: string;
  startedAt?: string;
}

/** 已安装插件信息 */
export interface MessagingConnectorDescriptor {
  packageName: string;
  version: string;
  channelId: string;
  displayName: string;
}

/** 授权用户信息 */
export interface AuthorizedUser {
  botId: string;
  senderId: string;
  senderName?: string;
  approvedAt: string;
}

/** Bot 状态变更事件（main -> renderer） */
export interface MessagingRuntimeChangedEvent {
  botId: string;
  state: BotState;
}

/** QR 扫码登录结果（loginWithQrStart） */
export interface QrLoginStartResult {
  qrDataUrl?: string;   // data:image/png;base64,...
  message: string;
}

export type QrLoginState =
  | 'connected'
  | 'need_verify_code'
  | 'already_connected'
  | 'expired'
  | 'verify_code_blocked'
  | 'error';

/** QR 扫码等待结果（loginWithQrWait） */
export interface QrLoginWaitResult {
  connected: boolean;
  state: QrLoginState;
  message: string;
  accountId?: string;
  alreadyConnected?: boolean;
}

export interface QrLoginSubmitCodeResult {
  accepted: boolean;
  message: string;
}

export interface QrLoginCancelResult {
  cancelled: boolean;
  message: string;
}

/** 登出结果（logoutAccount） */
export interface LogoutResult {
  cleared: boolean;
  loggedOut?: boolean;
}
