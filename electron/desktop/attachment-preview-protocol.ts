import { app, protocol } from 'electron';
import path from 'path';

export const ATTACHMENT_PREVIEW_SCHEME = 'piskie-attachment';
export const ATTACHMENT_PREVIEW_HOST = 'preview';

/**
 * 主题壁纸目录(与 theme.service 的落盘目录同源)。
 * 壁纸经同一特权 scheme 下的 theme-background host 静态服务
 * (host 常量与 URL 构造在 shared/constants/theme-background.ts,双进程共享)。
 */
export function themeBackgroundsDir(): string {
  return path.join(app.getPath('userData'), 'themes');
}

/** Must run before Electron becomes ready so Chromium treats previews as streamable resources. */
export function registerAttachmentPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ATTACHMENT_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}
