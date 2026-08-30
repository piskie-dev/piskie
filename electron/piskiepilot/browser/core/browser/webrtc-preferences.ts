/**
 * WebRTC IP 泄露防护 —— 通过 Chrome Profile Preferences 文件落地
 *
 * 重要：实测（Chrome 149）命令行 flag
 *   --force-webrtc-ip-handling-policy=disable_non_proxied_udp
 * 已不能阻止 srflx（STUN 反射的真实公网 IP）泄露。可靠的做法是把策略写入
 * 用户数据目录的 Preferences 文件（这正是反关联浏览器/隐私扩展采用的机制）：
 *   webrtc.ip_handling_policy      = 'disable_non_proxied_udp' | 'default'
 *   webrtc.multiple_routes_enabled = false（proxy 模式）
 *   webrtc.nonproxied_udp_enabled  = false（proxy 模式）
 *
 * 这些是普通（非 MAC 保护）偏好项，Chrome 启动时读取并生效；启动前合并写入即可，
 * 保留 Preferences 中其它已有设置。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import debug from 'debug';

const logger = debug('piskiepilot:webrtc-prefs');

export type WebrtcMode = 'proxy' | 'real';

/**
 * 在浏览器启动前，把 WebRTC 策略合并进 <userDataDir>/Default/Preferences。
 *
 * @param userDataDir Chrome 用户数据目录（puppeteer 的 userDataDir）
 * @param mode 'proxy' 开启防护；'real' 还原为默认（用于代理切回真实 IP 的场景）
 */
export async function ensureWebrtcPreferences(userDataDir: string, mode: WebrtcMode): Promise<void> {
  const defaultDir = path.join(userDataDir, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');
  // 读取现有 Preferences（不存在或损坏时按场景处理）
  let prefs: Record<string, any> = {};
  let existed = false;
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    prefs = JSON.parse(raw);
    existed = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // 文件存在但解析失败：不破坏它，放弃 Preferences 路径（仍有命令行 flag 兜底）
      logger('⚠️  Preferences 解析失败，跳过 WebRTC 偏好写入: %O', error);
      return;
    }
    // 不存在 → 新建（首次启动）
  }
  const desired =
    mode === 'proxy'
      ? {
          ip_handling_policy: 'disable_non_proxied_udp',
          multiple_routes_enabled: false,
          nonproxied_udp_enabled: false,
        }
      : {
          ip_handling_policy: 'default',
          multiple_routes_enabled: true,
          nonproxied_udp_enabled: true,
        };
  prefs.webrtc = { ...(prefs.webrtc || {}), ...desired };
  try {
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.writeFile(prefsPath, JSON.stringify(prefs), 'utf-8');
    logger('🛡️  WebRTC 偏好已写入 (%s, mode=%s): %s', existed ? '合并' : '新建', mode, prefsPath);
  } catch (error) {
    logger('⚠️  写入 WebRTC 偏好失败: %O', error);
  }
}
