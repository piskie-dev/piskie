/**
 * AppConfigStore - 应用设置投影
 *
 * 设置的持久化 owner 是 ConfigHost；这里仅为同步读取方保留受控快照。
 */

import type { AppSettings } from '../../../shared/types/index.js';
import { DEFAULT_SETTINGS } from '../../../shared/constants/index.js';

export class AppConfigStore {
  private controlledSettings: AppSettings = structuredClone(DEFAULT_SETTINGS);

  // ============================================================
  // 应用设置
  // ============================================================

  getSettings(): AppSettings {
    return structuredClone(this.controlledSettings);
  }

  /** ConfigHost publication bridge for synchronous settings readers. */
  publishSettings(settings: AppSettings): void {
    this.controlledSettings = structuredClone(settings);
  }
}

/** 单例导出 */
export const appConfigStore = new AppConfigStore();
