import fs from 'node:fs';
import path from 'node:path';

interface AccountSessionDocument {
  version: 1;
  accounts: Record<string, { pluginAccountId: string }>;
}

export class AccountSessionStore {
  private sessions = new Map<string, string>();

  constructor(private readonly filePath: string) {}

  load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return;
      throw cause;
    }
    if (!isAccountSessionDocument(raw)) {
      throw new TypeError(`Invalid IM account session state: ${this.filePath}`);
    }
    this.sessions = new Map(Object.entries(raw.accounts)
      .map(([botId, session]) => [botId, session.pluginAccountId]));
  }

  get(botId: string): string | undefined {
    return this.sessions.get(botId);
  }

  set(botId: string, pluginAccountId: string): void {
    this.sessions.set(botId, pluginAccountId);
    this.persist();
  }

  delete(botId: string): void {
    if (!this.sessions.delete(botId)) return;
    this.persist();
  }

  retain(botIds: ReadonlySet<string>): void {
    let changed = false;
    for (const botId of this.sessions.keys()) {
      if (botIds.has(botId)) continue;
      this.sessions.delete(botId);
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const document: AccountSessionDocument = {
      version: 1,
      accounts: Object.fromEntries([...this.sessions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([botId, pluginAccountId]) => [botId, { pluginAccountId }])),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

function isAccountSessionDocument(value: unknown): value is AccountSessionDocument {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.accounts)) return false;
  return Object.values(value.accounts).every((session) => (
    isRecord(session)
    && Object.keys(session).length === 1
    && typeof session.pluginAccountId === 'string'
    && session.pluginAccountId.length > 0
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
