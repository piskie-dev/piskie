import { contextBridge } from 'electron';
import packageMetadata from '../package.json' with { type: 'json' };
import { createElectronPiskieClient } from './transport/electron/piskie-client.js';
import { ElectronPreloadClient } from './transport/electron/preload-client.js';

const appVersion = packageMetadata.version;
const transport = new ElectronPreloadClient({ rendererBuildId: appVersion });
const api = createElectronPiskieClient({
  transport,
  version: appVersion,
  platform: process.platform,
});

contextBridge.exposeInMainWorld('piskie', api);
