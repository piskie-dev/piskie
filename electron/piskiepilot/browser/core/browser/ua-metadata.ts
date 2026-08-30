/**
 * User-Agent → User-Agent Client Hints 元数据推导
 *
 * 用于 clientHintsFromUA：根据 userAgent 字符串推导出
 * Protocol.Emulation.UserAgentMetadata，使浏览器上报的
 * navigator.userAgentData 与 Sec-CH-UA 请求头与 userAgent 自洽。
 *
 * 定位：基础防护。GREASE brand 无法从 UA 反推真实运行内核的取值，
 * 这里采用与 UA 主版本一致的合理构造，足以让维度间不再矛盾，
 * 但不保证与某个具体 Chrome 构建逐字节一致。
 */

/** 与 puppeteer 的 setUserAgent 第二参数兼容的元数据结构 */
export interface UAMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  fullVersion?: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
}

/**
 * 从 UA 字符串推导 Client Hints 元数据。
 * 仅支持 Chromium 系 UA（Chrome/Edge）；无法解析时返回 undefined，调用方应跳过 metadata。
 */
export function deriveUAMetadata(userAgent: string): UAMetadata | undefined {
  // 1. 主版本号：优先 Chrome，其次 Chromium
  const versionMatch =
    userAgent.match(/Chrome\/(\d+)\.([\d.]+)/) || userAgent.match(/Chromium\/(\d+)\.([\d.]+)/);
  if (!versionMatch) {
    return undefined;
  }
  const major = versionMatch[1];
  const fullVersion = `${versionMatch[1]}.${versionMatch[2]}`;
  // 2. 平台与平台版本
  const { platform, platformVersion } = derivePlatform(userAgent);
  // 3. 架构 / 位数
  const { architecture, bitness } = deriveArchitecture(userAgent);
  // 4. 移动标识
  const mobile = /Mobile|Android/i.test(userAgent);
  // 5. 品牌列表（含 GREASE）
  const brands = buildBrands(userAgent, major);
  const fullVersionList = buildBrands(userAgent, major, fullVersion);
  return {
    brands,
    fullVersionList,
    fullVersion,
    platform,
    platformVersion,
    architecture,
    model: '',
    mobile,
    bitness,
    wow64: false,
  };
}

function derivePlatform(ua: string): { platform: string; platformVersion: string } {
  if (/Windows NT ([\d.]+)/.test(ua)) {
    const ntMatch = ua.match(/Windows NT ([\d.]+)/);
    const nt = ntMatch ? ntMatch[1] : '10.0';
    // Windows 客户端提示的 platformVersion：NT 10.0 → "10.0.0"（Win10）/ "13.0.0"+（Win11，UA 无法区分，保守取 10.0.0）
    const ntMajorMinor = nt.split('.').slice(0, 2).join('.');
    return { platform: 'Windows', platformVersion: `${ntMajorMinor}.0` };
  }
  if (/Mac OS X ([\d_]+)/.test(ua)) {
    const macMatch = ua.match(/Mac OS X ([\d_]+)/);
    const ver = macMatch ? macMatch[1].replace(/_/g, '.') : '10.15.7';
    return { platform: 'macOS', platformVersion: ver };
  }
  if (/Android ([\d.]+)/.test(ua)) {
    const aMatch = ua.match(/Android ([\d.]+)/);
    return { platform: 'Android', platformVersion: aMatch ? aMatch[1] : '' };
  }
  if (/Linux|X11/.test(ua)) {
    return { platform: 'Linux', platformVersion: '' };
  }
  return { platform: '', platformVersion: '' };
}

function deriveArchitecture(ua: string): { architecture: string; bitness: string } {
  if (/arm|aarch64/i.test(ua)) {
    return { architecture: 'arm', bitness: /64|aarch64/i.test(ua) ? '64' : '32' };
  }
  if (/x86_64|Win64|x64|WOW64|Intel Mac/i.test(ua)) {
    return { architecture: 'x86', bitness: '64' };
  }
  if (/i686|i386|x86/i.test(ua)) {
    return { architecture: 'x86', bitness: '32' };
  }
  // 桌面默认 64 位 x86
  return { architecture: 'x86', bitness: '64' };
}

/**
 * 构造品牌列表。
 * 真实 Chrome 会带一个 GREASE 品牌 + Chromium + Google Chrome（或 Microsoft Edge）。
 * 当传入 fullVersion 时，版本用完整版本号（用于 fullVersionList）。
 */
function buildBrands(
  ua: string,
  major: string,
  fullVersion?: string
): Array<{ brand: string; version: string }> {
  const version = fullVersion || major;
  // GREASE 品牌：使用相对稳定的构造（真实取值随版本变化，无法从 UA 反推）
  const greaseVersion = fullVersion ? `${major}.0.0.0` : '24';
  const brands = [
    { brand: 'Not_A Brand', version: greaseVersion },
    { brand: 'Chromium', version },
  ];
  if (/Edg\//.test(ua)) {
    brands.push({ brand: 'Microsoft Edge', version });
  } else {
    brands.push({ brand: 'Google Chrome', version });
  }
  return brands;
}
