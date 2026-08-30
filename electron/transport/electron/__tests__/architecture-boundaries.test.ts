import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const productionRoots = ['electron', 'shared', 'src'];

function productionFiles(): string[] {
  const files: string[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'testing') continue;
        visit(child);
      } else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        files.push(child);
      }
    }
  };
  for (const directory of productionRoots) visit(directory);
  return files.sort();
}

function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

describe('Electron host greenfield architecture boundary', () => {
  it('keeps the deleted host stack absent with no compatibility alias', () => {
    for (const relative of [
      'electron/ipc/handlers.ts',
      'electron/ipc/im-gateway-handlers.ts',
      'electron/ipc/index.ts',
      'electron/ipc/renderer-projection.ts',
      'src/types/electron.d.ts',
    ]) {
      expect(fs.existsSync(path.join(root, relative)), relative).toBe(false);
    }

    const forbidden = [
      'registerIpcHandlers',
      'removeIpcHandlers',
      'registerImGatewayHandlers',
      'removeImGatewayHandlers',
      'window.electronAPI',
      'IPC_CHANNELS',
    ];
    for (const relative of productionFiles()) {
      const text = source(relative);
      for (const token of forbidden) expect(text, `${relative}: ${token}`).not.toContain(token);
    }
  });

  it('confines raw Electron messaging to the bootstrap adapters', () => {
    const allowed = new Map<string, readonly string[]>([
      ['ipcMain', ['electron/transport/electron/bootstrap-listener.ts']],
      ['ipcRenderer', ['electron/transport/electron/preload-client.ts']],
      ['contextBridge', ['electron/preload.ts']],
    ]);
    const files = productionFiles();
    for (const [token, expectedFiles] of allowed) {
      const actual = files.filter((relative) => source(relative).includes(token));
      expect(actual, token).toEqual(expectedFiles);
    }
    expect(files.reduce((count, relative) => (
      count + (source(relative).match(/piskie\.desktop\.connect\.v1/g)?.length ?? 0)
    ), 0)).toBe(1);
  });

  it('keeps main and preload as thin composition entries', () => {
    const main = source('electron/main.ts');
    const preload = source('electron/preload.ts');
    expect(main.split('\n').length).toBeLessThanOrEqual(8);
    expect(preload.split('\n').length).toBeLessThanOrEqual(20);
    expect(main).not.toMatch(/services\//);
    expect(main).toContain('void application.run()');
    expect(main).not.toContain('await application.run()');
    expect(preload).not.toMatch(/services\//);
    expect(preload.match(/exposeInMainWorld/g)).toHaveLength(1);
    expect(preload).toContain("exposeInMainWorld('piskie'");
  });
});
