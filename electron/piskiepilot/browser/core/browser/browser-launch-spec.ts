import type { RuntimeFingerprintConfig } from '@shared/types/index.js';

export interface BrowserLaunchProxy {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
  readonly bypassList?: readonly string[];
}

export interface BrowserLaunchIdentity {
  readonly language?: string;
  readonly timezone?: string;
  readonly userAgent?: string;
  readonly geolocation?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy?: number;
  };
}

export interface BrowserLaunchWindowSize {
  readonly width: number;
  readonly height: number;
}

/** Immutable, generation-scoped inputs that must be fixed before Chromium is spawned. */
export interface BrowserLaunchSpec {
  readonly generation: string;
  readonly browserId: string;
  readonly userDataId: string;
  readonly proxy?: BrowserLaunchProxy;
  readonly identity: BrowserLaunchIdentity;
  readonly fingerprint: Readonly<RuntimeFingerprintConfig>;
  readonly backgroundMode: boolean;
  /** Chromium outer-window size fixed before spawn; omitted to start maximized. */
  readonly windowSize?: Readonly<BrowserLaunchWindowSize>;
}
