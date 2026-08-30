import type { PiskieDesktopApi } from '../../../shared/electron-contracts/api.js';

declare global {
  interface Window {
    readonly piskie: PiskieDesktopApi;
  }
}

export {};
