/**
 * ScreenService - 浏览器截图与窗口控制
 *
 * 视频流不经本服务，浏览器流走 MessagePort IPC
 *（services/screen-stream.service.ts + piskiepilot screen-hub）。
 *
 * 本服务只保留单帧快照和窗口控制能力。
 */

import { browserControlPort } from '../core/pilot/pilot-manager.js';
import type { ScreenFrame } from '../../shared/types/index.js';
class ScreenService {
  /**
   * 获取浏览器页面单帧快照
   * @param browserId - 浏览器实例 ID
   * @param quality - JPEG 质量
   */
  async getSnapshot(browserId: string, quality = 80): Promise<ScreenFrame> {
    const snapshot = await browserControlPort.getSnapshot(browserId, quality);
    const data = decodeSnapshotData(snapshot.data);
    return {
      data,
      timestamp: snapshot.timestamp ?? Date.now(),
      browserId,
    };
  }

  /**
   * 显示浏览器窗口
   * @param browserId - 浏览器实例 ID
   * @returns 是否成功
   */
  async showWindow(browserId: string): Promise<boolean> {
    return browserControlPort.showWindow(browserId);
  }

}

/** 将 base64 data:url 或裸 base64 字符串转为 Uint8Array */
function decodeSnapshotData(input: string): Uint8Array {
  const base64 = input.startsWith('data:') ? input.split(',')[1] || '' : input;
  const buf = Buffer.from(base64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// 单例导出
export const screenService = new ScreenService();
export type { ScreenService };
