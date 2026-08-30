import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { appLog } from '@electron/observability/logging/app-log.js';
import { createChangeChannel, type ChangeSource } from '../core/change-channel.js';
import type {
  AuthorizedUser,
  SenderAuthorizationRequest,
  SenderAuthorizationRequestInput,
} from '../../shared/types/im-gateway.js';

export class SenderAuthorizationRegistry {
  private readonly authorizedUsersFilePath: string;
  private readonly requests = new Map<string, SenderAuthorizationRequest>();
  private authorizedUsers: AuthorizedUser[] = [];
  private readonly changeChannel = createChangeChannel<SenderAuthorizationRequest>({
    onSubscriberError: (error) =>
      appLog.error({
        event: 'messaging.authorization.publish.failed',
        message: 'Messaging authorization publication failed',
        context: { scope: 'messaging.authorization' },
        error,
      }),
  });

  readonly changes: ChangeSource<SenderAuthorizationRequest> = this.changeChannel.source;

  constructor(dataDirectory: string) {
    this.authorizedUsersFilePath = path.join(dataDirectory, 'authorized-users.json');
  }

  load(): void {
    this.authorizedUsers = readAuthorizedUsers(this.authorizedUsersFilePath);
  }

  authorizedUserCount(): number {
    return this.authorizedUsers.length;
  }

  listRequests(): SenderAuthorizationRequest[] {
    return [...this.requests.values()].filter((request) => request.status === 'pending');
  }

  approve(requestId: string): void {
    const request = this.pendingRequest(requestId);
    request.status = 'approved';
    this.authorizeSender(request.botId, request.senderId, request.senderName);
  }

  reject(requestId: string): void {
    const request = this.pendingRequest(requestId);
    request.status = 'rejected';
  }

  allowedSenderIds(botId: string): string[] {
    return this.authorizedUsers.filter((user) => user.botId === botId).map((user) => user.senderId);
  }

  listUsers(): AuthorizedUser[] {
    return structuredClone(this.authorizedUsers);
  }

  authorizeSender(botId: string, senderId: string, senderName?: string): void {
    if (this.hasAuthorizedSender(botId, senderId)) return;
    this.commitAuthorizedUsers(
      this.authorizedUsers.concat({
        botId,
        senderId,
        senderName,
        approvedAt: new Date().toISOString(),
      })
    );
  }

  removeUser(botId: string, senderId: string): void {
    this.authorizedUsers = this.authorizedUsers.filter(
      (user) => user.botId !== botId || user.senderId !== senderId
    );
    this.persistUsers();
  }

  requestAuthorization(input: SenderAuthorizationRequestInput): { code: string; created: boolean } {
    const existing = [...this.requests.values()].find(
      (request) =>
        request.botId === input.botId &&
        request.senderId === input.senderId &&
        request.status === 'pending'
    );
    if (existing) return { code: existing.pairingCode, created: false };

    const code = issuePairingCode();
    const request: SenderAuthorizationRequest = {
      ...input,
      id: `pair-${Date.now()}-${code}`,
      pairingCode: code,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    this.requests.set(request.id, request);
    this.changeChannel.sink.publish(request);
    return { code, created: true };
  }

  clearRuntimeRequests(): void {
    this.requests.clear();
  }

  private pendingRequest(requestId: string): SenderAuthorizationRequest {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') {
      throw new Error(`Sender authorization request not found: ${requestId}`);
    }
    return request;
  }

  private persistUsers(): void {
    fs.mkdirSync(path.dirname(this.authorizedUsersFilePath), { recursive: true });
    fs.writeFileSync(
      this.authorizedUsersFilePath,
      JSON.stringify(this.authorizedUsers, null, 2),
      'utf-8'
    );
  }

  private hasAuthorizedSender(botId: string, senderId: string): boolean {
    return this.authorizedUsers.some((user) => user.botId === botId && user.senderId === senderId);
  }

  private commitAuthorizedUsers(users: AuthorizedUser[]): void {
    this.authorizedUsers = users;
    this.persistUsers();
  }
}

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 6 位人工核对码，排除易混淆字符 I/O/0/1。 */
function issuePairingCode(): string {
  return Array.from(
    { length: 6 },
    () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]
  ).join('');
}

function readAuthorizedUsers(filePath: string): AuthorizedUser[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return Array.isArray(value) ? value.flatMap(parseAuthorizedUser) : [];
  } catch (error) {
    appLog.warn({
      event: 'messaging.authorization.load.degraded',
      message: 'Messaging authorization load degraded',
      context: { scope: 'messaging.authorization' },
      error,
    });
    return [];
  }
}

function parseAuthorizedUser(value: unknown): AuthorizedUser[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.botId !== 'string' ||
    typeof value.senderId !== 'string' ||
    typeof value.approvedAt !== 'string'
  )
    return [];
  return [
    {
      botId: value.botId,
      senderId: value.senderId,
      ...(typeof value.senderName === 'string' && { senderName: value.senderName }),
      approvedAt: value.approvedAt,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
