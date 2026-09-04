export const UPDATE_OPERATIONS = Object.freeze({
  status: 'updates.status',
  check: 'updates.check',
  restartAndInstall: 'updates.restartAndInstall',
} as const);

export const UPDATE_TOPICS = Object.freeze({
  status: 'updates.status.changes',
} as const);

export type UpdateDisabledReason =
  | 'development'
  | 'unpackaged'
  | 'unsupported-platform'
  | 'unavailable';

export interface UpdateTarget {
  readonly version: string;
}

interface UpdateStatusBase {
  readonly currentVersion: string;
}

export type PiskieUpdateStatus =
  | (UpdateStatusBase & {
      readonly state: 'disabled';
      readonly reason: UpdateDisabledReason;
    })
  | (UpdateStatusBase & { readonly state: 'idle' })
  | (UpdateStatusBase & { readonly state: 'checking' })
  | (UpdateStatusBase & {
      readonly state: 'up-to-date';
      readonly checkedAt: string;
    })
  | (UpdateStatusBase & {
      readonly state: 'available';
      readonly target: UpdateTarget;
    })
  | (UpdateStatusBase & {
      readonly state: 'downloading';
      readonly target: UpdateTarget;
      readonly percent: number;
    })
  | (UpdateStatusBase & {
      readonly state: 'downloaded';
      readonly target: UpdateTarget;
    })
  | (UpdateStatusBase & {
      readonly state: 'error';
      readonly error: 'no-release' | 'network' | 'generic';
      readonly checkedAt: string;
      readonly retryable: true;
    });

export interface UpdateClient {
  status(): Promise<PiskieUpdateStatus>;
  check(): Promise<PiskieUpdateStatus>;
  restartAndInstall(): Promise<boolean>;
  observeStatus(listener: (status: PiskieUpdateStatus) => void): () => void;
}
