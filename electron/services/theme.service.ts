import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * ThemeService 主题背景服务
 * 负责背景图片的选取、压缩与落盘清理：
 * - 图片统一拷贝进 {userData}/themes/，不引用用户原路径（防原图被移动/删除后失效）
 * - 超出主显示器物理像素的图先压缩再落盘，避免 4K+ 原图常驻显存
 * - 目录内只保留当前一张背景；文件名带时间戳，避免 file:// 层缓存复用旧图
 * - 背景 URI 由 app-settings 持久化，本服务只管文件
 */

import { app, nativeImage, screen } from 'electron';
import fs from 'fs';
import path from 'path';
import { themeBackgroundUrl } from '../../shared/constants/theme-background.js';
class ThemeService {
  private get themesDir(): string {
    return path.join(app.getPath('userData'), 'themes');
  }

  /**
   * 将 Desktop adapter 已授权的背景图压缩落盘,返回 theme-background 特权协议 URL。
   */
  async importBackgroundImage(sourcePath: string): Promise<string> {
    // nativeImage 只支持 PNG/JPEG 解码：webp 等格式读出来是空图。
    // 解不开就跳过压缩、原样拷贝——Chromium 渲染端都能显示，
    // 且此类格式（webp）自身压缩率已高，压缩收益本就有限
    const image = nativeImage.createFromPath(sourcePath);
    const decodable = !image.isEmpty();

    // 上限取主显示器物理像素的最长边（logical size × scaleFactor），
    // cover 展示下再高的分辨率也不产生视觉收益
    const { width, height } = decodable ? image.getSize() : { width: 0, height: 0 };
    const display = screen.getPrimaryDisplay();
    const maxEdge = Math.max(display.size.width, display.size.height) * display.scaleFactor;

    fs.mkdirSync(this.themesDir, { recursive: true });
    this.clearBackgroundImages();

    let destPath: string;
    if (!decodable || Math.max(width, height) <= maxEdge) {
      // 尺寸达标或无法解码：原样拷贝，保留原格式与质量
      const ext = path.extname(sourcePath).toLowerCase() || '.png';
      destPath = path.join(this.themesDir, `background-${Date.now()}${ext}`);
      fs.copyFileSync(sourcePath, destPath);
    } else {
      const scale = maxEdge / Math.max(width, height);
      const resized = image.resize({
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        quality: 'best',
      });
      destPath = path.join(this.themesDir, `background-${Date.now()}.jpg`);
      fs.writeFileSync(destPath, resized.toJPEG(90));
    }

    appLog.info({
      event: 'config.theme.persist.completed',
      message: 'Theme background persisted',
      context: {
        scope: 'config.theme',
        destinationPath: destPath,
        originalWidth: width,
        originalHeight: height,
        maxEdge,
      },
    });
    // 返回特权协议 URL 而非 file://:http 开发页 + webSecurity 会拦 file://
    // 子资源(壁纸黑屏回归的根因);协议 URL 开发/生产同一条加载路径
    return themeBackgroundUrl(path.basename(destPath));
  }

  /**
   * 清空背景图片文件（恢复默认）
   */
  clearBackgroundImages(): void {
    if (!fs.existsSync(this.themesDir)) {
      return;
    }
    for (const name of fs.readdirSync(this.themesDir)) {
      if (name.startsWith('background-')) {
        fs.rmSync(path.join(this.themesDir, name), { force: true });
      }
    }
  }
}

export const themeService = new ThemeService();
export type { ThemeService };
