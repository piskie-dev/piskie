import { createUuid } from '@shared/utils/identifiers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'piskie-paths-user-data') },
}));

import { pathsService } from '../paths.service.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
  );
});

describe('PathsService agent temp directories', () => {
  it('uses a distinct system temp directory for each Agent ID', () => {
    expect(pathsService.getTempDir('main-1')).toBe(path.join(os.tmpdir(), 'piskie', 'main-1'));
    expect(pathsService.getTempDir('local-main-1-1')).toBe(
      path.join(os.tmpdir(), 'piskie', 'local-main-1-1')
    );
  });

  it('creates the Agent temp directory outside the workspace', async () => {
    const agentId = `paths-test-${createUuid()}`;
    const tempDir = pathsService.getTempDir(agentId);
    cleanupPaths.push(tempDir);

    await pathsService.ensureTempDir(agentId);

    expect((await fs.stat(tempDir)).isDirectory()).toBe(true);
  });

  it('creates an empty workspace without adding .piskie', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-workspace-test-'));
    const workspace = path.join(root, 'project');
    cleanupPaths.push(root);

    await pathsService.ensureWorkspace(workspace);

    await expect(fs.readdir(workspace)).resolves.toEqual([]);
  });
});
