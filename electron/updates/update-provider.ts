export interface UpdateRelease {
  readonly version: string;
}

export interface UpdateDownloadProgress {
  readonly percent: number;
}

export type UpdateProviderEvent =
  | { readonly type: 'checking' }
  | { readonly type: 'not-available' }
  | { readonly type: 'available'; readonly release: UpdateRelease }
  | { readonly type: 'progress'; readonly progress: UpdateDownloadProgress }
  | { readonly type: 'downloaded'; readonly release: UpdateRelease }
  | { readonly type: 'error'; readonly error: unknown };

export interface UpdateProvider {
  subscribe(listener: (event: UpdateProviderEvent) => void): () => void;
  checkForUpdates(): Promise<void>;
  quitAndInstall(): void;
}
