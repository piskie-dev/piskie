import { createElectronApplication } from './bootstrap/create-electron-application.js';

const application = createElectronApplication();
if (application) void application.run();
