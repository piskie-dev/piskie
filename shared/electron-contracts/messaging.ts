import type {
  AuthorizedUser,
  MessagingConnectionConfig,
  MessagingConnectorDescriptor,
  LogoutResult,
  SenderAuthorizationRequest,
  QrLoginCancelResult,
  QrLoginStartResult,
  QrLoginSubmitCodeResult,
  QrLoginWaitResult,
} from '../types/im-gateway.js';

export type { MessagingConnectionConfig } from '../types/im-gateway.js';

export type SaveMessagingConnectionRequest = MessagingConnectionConfig;

export interface MessagingConnectionState {
  config: MessagingConnectionConfig;
  status: import('../types/im-gateway.js').BotStatus;
  error?: string;
  startedAt?: string;
}

export interface MessagingConnectionChangedEvent {
  botId: string;
  state: MessagingConnectionState;
}

export const MESSAGING_OPERATIONS = Object.freeze({
  listConnectors: 'messaging.listConnectors',
  saveBot: 'messaging.saveBot',
  deleteBot: 'messaging.deleteBot',
  startBot: 'messaging.startBot',
  stopBot: 'messaging.stopBot',
  status: 'messaging.status',
  pendingAuthorization: 'messaging.pendingAuthorization',
  approve: 'messaging.approve',
  reject: 'messaging.reject',
  authorizedUsers: 'messaging.authorizedUsers',
  addAuthorizedUser: 'messaging.addAuthorizedUser',
  removeAuthorizedUser: 'messaging.removeAuthorizedUser',
  startQrLogin: 'messaging.startQrLogin',
  waitForQrLogin: 'messaging.waitForQrLogin',
  submitQrCode: 'messaging.submitQrCode',
  cancelQrLogin: 'messaging.cancelQrLogin',
  logoutAccount: 'messaging.logoutAccount',
} as const);

export const MESSAGING_TOPICS = Object.freeze({
  status: 'messaging.status',
  authorization: 'messaging.authorization',
} as const);

export interface MessagingClient {
  listConnectors(): Promise<MessagingConnectorDescriptor[]>;
  saveBot(config: SaveMessagingConnectionRequest): Promise<void>;
  deleteBot(botId: string): Promise<void>;
  startBot(botId: string): Promise<void>;
  stopBot(botId: string): Promise<void>;
  status(): Promise<{ botStates: MessagingConnectionState[]; configs: MessagingConnectionConfig[] }>;
  pendingAuthorization(): Promise<SenderAuthorizationRequest[]>;
  approve(requestId: string): Promise<void>;
  reject(requestId: string): Promise<void>;
  authorizedUsers(): Promise<AuthorizedUser[]>;
  addAuthorizedUser(botId: string, senderId: string, senderName?: string): Promise<void>;
  removeAuthorizedUser(botId: string, senderId: string): Promise<void>;
  startQrLogin(botId: string, channelType: string, force?: boolean): Promise<QrLoginStartResult>;
  waitForQrLogin(botId: string, channelType: string): Promise<QrLoginWaitResult>;
  submitQrCode(botId: string, channelType: string, code: string): Promise<QrLoginSubmitCodeResult>;
  cancelQrLogin(botId: string, channelType: string): Promise<QrLoginCancelResult>;
  logoutAccount(botId: string): Promise<LogoutResult>;
  observeStatus(listener: (event: MessagingConnectionChangedEvent) => void): () => void;
  observeAuthorization(listener: (request: SenderAuthorizationRequest) => void): () => void;
}
