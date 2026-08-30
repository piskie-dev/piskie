export interface VersionedConfigDocument {
  revision: number;
}

export interface VersionedConfigRepositoryPaths {
  configFile: string;
  historyDirectory: string;
  lockFile: string;
}

export interface VersionedConfigRepository<T extends VersionedConfigDocument> {
  exists(): Promise<boolean>;
  initialize(document: T): Promise<void>;
  read(): Promise<T>;
  readRevision(revision: number): Promise<T>;
  history(): Promise<readonly number[]>;
  pruneHistory(): Promise<readonly number[]>;
  commit(candidate: T, expectedRevision: number): Promise<T>;
}

export type ConfigRepositoryErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_LOCKED'
  | 'CONFIG_REVISION_CONFLICT'
  | 'CONFIG_WRITE_FAILED'
  | 'CONFIG_HISTORY_NOT_FOUND';

export class ConfigRepositoryError extends Error {
  constructor(
    readonly code: ConfigRepositoryErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigRepositoryError';
  }
}
