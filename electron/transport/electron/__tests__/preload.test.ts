import { expect, it, vi } from 'vitest';
import type { PiskieDesktopApi } from '../../../../shared/electron-contracts/index.js';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), getPathForFile: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  webUtils: { getPathForFile: electron.getPathForFile },
}));
vi.mock('../preload-client.js', () => ({ ElectronPreloadClient: class {} }));

it('exposes Electron webUtils path resolution through the desktop file bridge', async () => {
  await import('../../../preload.js');
  expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
  const [name, api] = electron.exposeInMainWorld.mock.calls[0] as [string, PiskieDesktopApi];
  expect(name).toBe('piskie');
  const file = new File(['Sample'], 'example.pdf', { type: 'application/pdf' });
  electron.getPathForFile.mockReturnValueOnce('/sample files/example.pdf').mockReturnValueOnce('');
  expect(api.desktop.files.getPathForFile(file)).toBe('/sample files/example.pdf');
  expect(electron.getPathForFile).toHaveBeenCalledWith(file);
  expect(api.desktop.files.getPathForFile(new File(['Sample'], 'memory.pdf'))).toBe('');
});
