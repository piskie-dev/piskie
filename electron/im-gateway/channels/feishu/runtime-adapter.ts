/**
 * 飞书渠道的 openclaw runtime 宿主实例
 *
 * 实现见 core/openclaw-runtime-host.ts（渠道参数化共享组件），
 * 经 LarkClient.setRuntime() 注入 vendor 代码。
 */

import { OpenClawRuntimeHost } from '../../core/openclaw-runtime-host.js';

export const feishuRuntimeHost = new OpenClawRuntimeHost('feishu');
