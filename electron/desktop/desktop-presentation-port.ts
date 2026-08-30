import type { ChangeSource } from '../core/change-channel.js';
import type { EmbeddedBrowserState } from '../../shared/types/embedded-browser.js';
import type { CallerWindowConfig } from '../../shared/types/index.js';
import type { BrowserLaunchWindowSize } from '../piskiepilot/browser/core/browser/browser-launch-spec.js';
import type { DesktopColorScheme } from '../../shared/electron-contracts/desktop.js';

export interface DesktopAppearancePort {
  setColorScheme(colorScheme: DesktopColorScheme): void;
}

export interface EmbeddedBrowserPresentation {
  readonly changes: ChangeSource<EmbeddedBrowserState>;
  state(): EmbeddedBrowserState;
  navigate(address: string): Promise<boolean>;
  openLocalHtml(filePath: string): Promise<void>;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
}

export interface DesktopPresentationPort {
  pilotCallerWindow(): CallerWindowConfig;
  pilotBrowserWindowSize(): BrowserLaunchWindowSize | undefined;

  openAuthorization(
    url: string,
    onClosed?: () => void,
  ): Promise<() => void>;

  embeddedBrowser(windowId: number): EmbeddedBrowserPresentation;

  openDevTools(windowId: number): void;

  chooseFiles(
    windowId: number,
    request: { type: 'file' | 'folder' | 'any' },
  ): Promise<string[]>;

  chooseBackgroundImage(windowId: number): Promise<string | undefined>;

  createFilePreviewUrl(windowId: number, filePath: string, mediaType: string): string;

  chooseSavePath(
    windowId: number,
    request: {
      title: string;
      suggestedName: string;
      extensions: readonly string[];
    },
  ): Promise<string | undefined>;
}
