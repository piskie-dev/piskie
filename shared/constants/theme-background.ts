/**
 * 主题壁纸 URL 常量(主进程/渲染进程共享)。
 *
 * 壁纸经 `piskie-attachment://theme-background/<文件名>` 特权协议加载:
 * 持久化 URL 需跨窗口/跨启动稳定,不能走 attachment 的按窗口 token 模型;
 * 而 file:// URI 会被 http 开发页(renderer-entry 127.0.0.1:5174)+
 * webSecurity 拦截——这正是「选了壁纸不显示」回归的根因。
 *
 * scheme 字面量须与 electron/desktop/attachment-preview-protocol.ts 的
 * ATTACHMENT_PREVIEW_SCHEME 一致(渲染进程无法 import electron 侧模块,
 * 跨进程边界的字符串只能约定同步)。
 */

export const THEME_BACKGROUND_HOST = 'theme-background';

export const THEME_BACKGROUND_URL_PREFIX = `piskie-attachment://${THEME_BACKGROUND_HOST}/`;

/** 遮罩不透明度下限。 */
export const APP_BG_MASK_MIN = 0.01;
/** 遮罩默认不透明度。 */
export const APP_BG_MASK_DEFAULT = 0.65;
/** 遮罩不透明度上限。 */
export const APP_BG_MASK_MAX = 0.99;

const THEME_BACKGROUND_URL_PATTERN =
  /^piskie-attachment:\/\/theme-background\/background-[A-Za-z0-9%._~-]+\.(?:png|jpe?g|webp)$/i;

/** 由落盘文件名构造壁纸 URL(文件名带时间戳,可长缓存) */
export function themeBackgroundUrl(fileName: string): string {
  return THEME_BACKGROUND_URL_PREFIX + encodeURIComponent(fileName);
}

export function isThemeBackgroundUrl(uri: string): boolean {
  if (!THEME_BACKGROUND_URL_PATTERN.test(uri)) return false;
  try {
    const fileName = decodeURIComponent(uri.slice(THEME_BACKGROUND_URL_PREFIX.length));
    return fileName.startsWith('background-')
      && !fileName.includes('/')
      && !fileName.includes('\\')
      && !fileName.includes('..');
  } catch {
    return false;
  }
}
