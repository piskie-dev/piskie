export const DESKTOP_OPERATIONS = Object.freeze({
  info: 'desktop.system.info',
  openDevTools: 'desktop.system.openDevTools',
  openExternal: 'desktop.system.openExternal',
  openPath: 'desktop.system.openPath',
  revealPath: 'desktop.system.revealPath',
  openWorkspace: 'desktop.system.openWorkspace',
  openAgentRunTrace: 'desktop.system.openAgentRunTrace',
  clipboardAttachments: 'desktop.system.clipboardAttachments',
  previewFile: 'desktop.files.preview',
  selectFiles: 'desktop.files.select',
  pickBackground: 'desktop.theme.pickBackground',
  clearBackground: 'desktop.theme.clearBackground',
  setColorScheme: 'desktop.theme.setColorScheme',
} as const);

export type DesktopColorScheme = 'light' | 'dark';

export type FilePreviewDescriptor =
  | {
      readonly kind: 'image';
      readonly url: string;
      readonly mediaType: string;
      readonly size: number;
    }
  | {
      readonly kind: 'text';
      readonly content: string;
      readonly truncated: boolean;
      readonly size: number;
    }
  | {
      readonly kind: 'file';
      readonly mediaType?: string;
      readonly size: number;
    };

export interface ClipboardAttachmentDescriptor {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mediaType?: string;
  readonly previewUrl?: string;
}

export const DESKTOP_TOPICS = Object.freeze({
  network: 'desktop.system.network',
} as const);

interface DesktopSystemClient {
  readonly platform: string;
  info(): Promise<{ name: string; version: string }>;
  openDevTools(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  openWorkspace(workspace?: string): Promise<void>;
  openAgentRunTrace(agentId: string): Promise<void>;
  clipboardAttachments(): Promise<ClipboardAttachmentDescriptor[]>;
  observeNetwork(listener: (online: boolean) => void): () => void;
}

interface DesktopFilesClient {
  preview(path: string): Promise<FilePreviewDescriptor>;
  select(input?: { type?: 'file' | 'folder' | 'any' }): Promise<string[]>;
}

interface DesktopThemeClient {
  pickBackground(): Promise<string | null>;
  clearBackground(): Promise<void>;
  setColorScheme(colorScheme: DesktopColorScheme): Promise<void>;
}

export interface DesktopClient {
  readonly system: DesktopSystemClient;
  readonly files: DesktopFilesClient;
  readonly theme: DesktopThemeClient;
}
