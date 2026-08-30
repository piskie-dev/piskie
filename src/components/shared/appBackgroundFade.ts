/**
 * 主题背景应用与切换动效
 *
 * 背景状态的可视化路径是命令式的：直接在 <html> 上写 CSS 变量与 data-app-bg 属性，
 * 不经 React 渲染——这样 startViewTransition 回调返回时 DOM 已同步就位，
 * 无需 flushSync，换背景也不触发任何组件重渲染。
 * 持久化以 app-settings 为唯一事实源；uiStore 保留当前 Renderer 投影，
 * AppBackground 组件的 effect 会在投影变化后幂等地重放这里的写入。
 *
 * 动效沿革：最初是 QQ 式圆形扩散（clipPath circle + 关默认 cross-fade），
 * 用户 2026-08-06 裁决换成淡入淡出——即 view transition 的默认交叉淡化，
 * 只需调时长曲线（base.css 的 .app-bg-fading 作用域规则），自定义动画整个退役。
 */

import {
  APP_BG_MASK_MAX,
  APP_BG_MASK_MIN,
} from '../../../shared/constants/theme-background';

export {
  APP_BG_MASK_MAX,
  APP_BG_MASK_MIN,
};

/**
 * 把背景状态写到 <html>：CSS 变量供 AppBackground 层消费，
 * data-app-bg 属性触发 tokens.css / base.css 里结构底色的透明覆盖。幂等。
 *
 * 无壁纸不等于无背景：默认底是 --app-ambient 弥散光渐变（tokens.css 按主题
 * 定义，data-theme 切换自动跟随），遮罩为 0；用户壁纸则用其 URI + 遮罩滑杆值。
 * 因此 data-app-bg 常态存在，结构层常态透明。
 */
export function applyAppBackgroundVars(uri: string | null, maskOpacity: number): void {
  const root = document.documentElement;
  if (uri) {
    root.style.setProperty('--app-bg-image', `url("${uri}")`);
    root.style.setProperty('--app-bg-mask', String(maskOpacity));
  } else {
    root.style.setProperty('--app-bg-image', 'var(--app-ambient)');
    root.style.setProperty('--app-bg-mask', '0');
  }
  // 区分背景种类，避免默认弥散光下玻璃列与透明列出现突兀色差：
  // - 'image'   = 用户壁纸：杂乱底，阅读面需要玻璃衬底（--glass-*）
  // - 'ambient' = 弥散光默认底：自家柔光，无需玻璃——全屏同色调，避免
  //   玻璃列与透明列并排时的色差突兀
  // 存在性选择器 [data-app-bg] 继续匹配两者（结构透明覆盖不变）
  root.setAttribute('data-app-bg', uri ? 'image' : 'ambient');
}

/**
 * 以交叉淡化切换背景：view transition 默认动画，新旧界面整体淡入淡出。
 * 图片先解码再切换，避免淡入一张还没加载完的图。
 * opts.theme：随同一次淡化一并翻转 <html data-theme>，供自动主题跟随壁纸明暗——
 * CSS 侧与壁纸同步渐变；AntD 侧由 App.tsx 的 React 状态随后跟上。
 */
export async function fadeAppBackground(
  uri: string | null,
  maskOpacity: number,
  opts?: { theme?: 'light' | 'dark' },
): Promise<void> {
  if (uri) {
    const image = new Image();
    image.src = uri;
    try {
      await image.decode();
    } catch {
      // 解码失败不阻断切换：最坏情况是淡入过程中图片渐进显示
    }
  }

  const root = document.documentElement;
  root.classList.add('app-bg-fading');
  const transition = document.startViewTransition(() => {
    applyAppBackgroundVars(uri, maskOpacity);
    if (opts?.theme) {
      root.setAttribute('data-theme', opts.theme);
    }
  });
  try {
    await transition.finished;
  } finally {
    root.classList.remove('app-bg-fading');
  }
}

/**
 * 估算图片明暗，作为自动主题跟随壁纸的判据：缩样到 16×16 后取平均相对亮度。
 * 在渲染进程做而非主进程——Chromium 能解码 webp 等全部格式（nativeImage 只解 PNG/JPEG）。
 * 无法判定（解码/取样失败）返回 null，调用方按深色兜底。
 */
export async function estimateImageIsLight(uri: string): Promise<boolean | null> {
  try {
    const image = new Image();
    // 协议 URL 对页面是跨源的:不带 crossOrigin 会污染 canvas,getImageData 直接抛错。
    // 响应侧已回 Access-Control-Allow-Origin: *;file:// 旧值不加(file 响应无 CORS 头,加了反而载入失败)
    if (!uri.startsWith('file:')) image.crossOrigin = 'anonymous';
    image.src = uri;
    await image.decode();
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let sum = 0;
    for (let i = 0; i + 2 < data.length; i += 4) {
      sum += 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
    }
    const avg = sum / (data.length / 4) / 255;
    return avg > 0.55;
  } catch {
    return null;
  }
}
