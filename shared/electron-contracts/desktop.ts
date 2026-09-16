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
  releasePreview: 'desktop.files.releasePreview',
  selectFiles: 'desktop.files.select',
  workspaceInfo: 'desktop.workspace.info',
  switchWorkspaceBranch: 'desktop.workspace.switchBranch',
  createWorkspaceBranch: 'desktop.workspace.createBranch',
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
    }
  | { readonly kind: 'directory' };

export type ClipboardAttachmentRequest =
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'native'; readonly files: readonly { readonly name: string; readonly size: number }[]; readonly text: string };

export type ClipboardAttachmentDescriptor = {
  readonly name: string;
  readonly path: string;
  readonly size: number;
} & ({ readonly kind: 'image'; readonly previewUrl: string } | { readonly kind: 'file' | 'directory' });

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
  clipboardAttachments(request: ClipboardAttachmentRequest): Promise<ClipboardAttachmentDescriptor[]>;
  observeNetwork(listener: (online: boolean) => void): () => void;
}

interface DesktopFilesClient {
  /** Resolves a DOM File in preload; returns an empty string for files without a disk backing. */
  getPathForFile(file: File): string;
  preview(path: string): Promise<FilePreviewDescriptor>;
  releasePreview(url: string): Promise<void>;
  select(input?: { type?: 'file' | 'folder' | 'any' }): Promise<string[]>;
}

interface DesktopThemeClient {
  pickBackground(): Promise<string | null>;
  clearBackground(): Promise<void>;
  setColorScheme(colorScheme: DesktopColorScheme): Promise<void>;
}

export type WorkspaceGitHead =
  | { readonly kind: 'branch'; readonly name: string; readonly commit: string }
  | { readonly kind: 'unborn'; readonly name: string }
  | { readonly kind: 'detached'; readonly commit: string };

export interface WorkspaceGitInfo {
  readonly root: string;
  readonly head: WorkspaceGitHead;
  readonly branches: readonly string[];
  /** Changed worktree entries, including staged, unstaged and untracked files. */
  readonly dirtyFileCount: number;
}

export interface WorkspaceInfo {
  readonly path: string;
  readonly git: WorkspaceGitInfo | null;
  /** A directory or Git read failure; distinct from a non-Git directory. */
  readonly error?: string;
}

interface DesktopWorkspaceClient {
  /** Omitting the path selects the application's default workspace. */
  info(workspace?: string): Promise<WorkspaceInfo>;
  switchBranch(workspace: string, branch: string): Promise<WorkspaceInfo>;
  /** Creates from the displayed HEAD; rejects a stale base before changing the working tree. */
  createBranch(workspace: string, branch: string, base: WorkspaceGitHead): Promise<WorkspaceInfo>;
}

export interface DesktopClient {
  readonly system: DesktopSystemClient;
  readonly files: DesktopFilesClient;
  readonly workspace: DesktopWorkspaceClient;
  readonly theme: DesktopThemeClient;
}
