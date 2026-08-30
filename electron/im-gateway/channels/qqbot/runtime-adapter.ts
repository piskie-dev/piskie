/**
 * QQ 机器人渠道的 openclaw runtime 宿主实例
 *
 * 实现见 core/openclaw-runtime-host.ts（渠道参数化共享组件），
 * 经 vendor runtime.js 的 setQQBotRuntime() 注入。
 * qqbot 实际消费面是 feishu 的子集：config.loadConfig/writeConfigFile、
 * channel.routing.resolveAgentRoute、channel.reply.{finalizeInboundContext,
 * resolveEnvelopeFormatOptions, dispatchReplyWithBufferedBlockDispatcher}、
 * channel.text.{hasControlCommand, chunkMarkdownText}、version（注入 UA）。
 */

import { OpenClawRuntimeHost } from '../../core/openclaw-runtime-host.js';

export const qqbotRuntimeHost = new OpenClawRuntimeHost('qqbot');
