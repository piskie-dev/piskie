import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { app } from 'electron';

class PathsService {
  private _defaultWorkspaceDir = '';
  private _initialized = false;

  private ensureInit(): void {
    if (!this._initialized) {
      this._defaultWorkspaceDir = path.join(app.getPath('userData'), 'workspace');
      this._initialized = true;
    }
  }

  getDefaultWorkspaceDir(): string {
    this.ensureInit();
    return this._defaultWorkspaceDir;
  }

  getTempDir(agentId: string): string {
    return path.join(this.getTempRootDir(), agentId);
  }

  getTempRootDir(): string {
    return path.join(os.tmpdir(), 'piskie');
  }

  async ensureWorkspace(workspaceDir?: string): Promise<void> {
    this.ensureInit();
    const workspace = workspaceDir || this._defaultWorkspaceDir;
    await fs.mkdir(workspace, { recursive: true });
  }

  async ensureTempDir(agentId: string): Promise<void> {
    await fs.mkdir(this.getTempDir(agentId), { recursive: true });
  }
}

export const pathsService = new PathsService();
