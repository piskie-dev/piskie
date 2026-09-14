import { contextBridge, webUtils } from 'electron';
import packageMetadata from '../package.json' with { type: 'json' };
import { createElectronPiskieClient } from './transport/electron/piskie-client.js';
import { ElectronPreloadClient } from './transport/electron/preload-client.js';

const appVersion = packageMetadata.version;
const transport = new ElectronPreloadClient({ rendererBuildId: appVersion });
const api = createElectronPiskieClient({
  transport,
  version: appVersion,
  platform: process.platform,
  getPathForFile: (file) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld('piskie', api);
