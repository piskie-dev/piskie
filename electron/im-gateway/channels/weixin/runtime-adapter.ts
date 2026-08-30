/**
 * 微信个人号渠道的 openclaw runtime 宿主实例
 *
 * 实现见 core/openclaw-runtime-host.ts，由 connector 按次注入 runtime/channelRuntime。
 * 渠道 key 为 channel-descriptors 声明的 canonical `openclaw-weixin`。
 */

import { OpenClawRuntimeHost } from '../../core/openclaw-runtime-host.js';

export const weixinRuntimeHost = new OpenClawRuntimeHost('openclaw-weixin');
