import { appLog } from '@electron/observability/logging/app-log.js';
import { createUuid } from '@shared/utils/identifiers.js';
/**
 * InboundPipeline — 进站消息编排器
 *
 *   鉴权已由渠道完成
 *   -> 规范化消息（sender 校验、空消息判定）
 *   -> resolveImAgentLaunch(bot, peer)
 *   -> commandRouter.tryExecute()
 *        |-- handled -> 当前 ReplyDispatcher 直接发送回执并收尾（kind='direct'）
 *        `-- null -> 媒体校验/转换 -> 群 sender 信封
 *                  -> restore the conversation's AgentRun or start a new one
 *                  -> 安装最新 dispatcher
 *                  -> injectEventToAgent()
 *                       |-- 接受 -> waitForNextYield，等待任意 turn_end 释放
 *                       `-- false/抛错 -> 不跨世代重投，CAS 清本次旧 binding
 *                  -> finally 完成本次 queue 收尾
 *
 * 不读 activeRuntimes、不扫 header、不调用 startAgent/resumeAgent/stopAgent/
 * restartAgent、不出现具体命令字符串；核心层不对同一 agent 串行化并发消息
 * （渠道自有队列保持现状）。
 */

import path from 'path';
import fs from 'fs';
import { createDeliveryQueue } from './outbound.js';
import { deliverDirectFinalReply } from './direct-reply-delivery.js';
import {
  cleanupInboundMedia,
  getManagedMediaDir,
  validateAndConvertInboundMedia,
  type InboundImagePayload,
} from './inbound-media.js';
import { buildAgentText, hasValidSenderId, SENDER_REJECT_REPLY } from './sender-envelope.js';
import { deliverCommandResultDirect } from './direct-reply-delivery.js';
import {
  ImTaskDefinitionUnavailableError,
  resolveImAgentLaunch,
} from './agent-launch.js';
import type { ReplyInterceptor, DispatchYieldOutcome } from '../reply-interceptor.js';
import type { IMCommandRouter } from '../commands/command-router.js';
import type { IMAgentCommands } from '../agent-ports.js';
import type { MessagingAgentSession } from '../messaging-agent-session.js';
import type {
  ConnectorContext,
  ConnectorLogger,
  DispatchCallbacks,
  DispatchResult,
  InboundMessage,
  LateSink,
  MediaApi,
  PairingApi,
  ReplyDispatcher,
} from './channel-connector.js';
import type {
  MessagingConnectionConfig,
  SenderAuthorizationRequestInput,
} from '../../../shared/types/im-gateway.js';

// 消息未能进入 Agent（依赖缺失/空消息/abort/inject 失败）的统一运输结果
const EMPTY_RESULT: DispatchResult = {
  kind: 'agent',
  completion: 'inject_rejected',
  counts: { block: 0, tool: 0, final: 0 },
};

export interface PipelineDeps {
  agentService?: IMAgentCommands;
  agentSessions?: MessagingAgentSession;
  /** 完整类型化：不经 any 调用 setDispatcher/waitForNextYield 等运输方法 */
  replyInterceptor?: ReplyInterceptor;
  /** 命令注册表（IMGateway 注入；Pipeline 不导入具体 command class） */
  commandRouter?: IMCommandRouter;
  authorization?: SenderAuthorizationPort;
}

export interface SenderAuthorizationPort {
  allowedSenderIds(botId: string): string[];
  requestAuthorization(
    input: SenderAuthorizationRequestInput,
  ): { code: string; created: boolean };
}

/** Bot 绑定模板失效时的直接配置错误回执 */
export const TASK_DEFINITION_MISSING_REPLY =
  'Bot 尚未绑定可用的启动任务，请在设置中绑定后重启 Bot';

export class InboundPipeline {
  private deps: PipelineDeps;
  /** botId → 迟到帧兜底投递（渠道可选注册） */
  private lateSinks = new Map<string, LateSink>();
  private readonly rejectionReportedAt = new Map<string, number>();

  constructor(deps: PipelineDeps = {}) {
    this.deps = deps;
  }

  /** 迟绑定依赖（服务初始化后注入，与 IMGateway.injectDependencies 同源） */
  setDependencies(deps: PipelineDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** 为一次 connector.start() 构建上下文 */
  buildContext(bot: MessagingConnectionConfig, signal: AbortSignal): ConnectorContext {
    const log = buildLogger(bot);
    return {
      bot,
      signal,
      log,
      pairing: this.buildPairingApi(bot),
      media: buildMediaApi(),
      // abort 后拒绝开始新的 dispatch——停止中的 connector 不再把消息送进 Agent；
      // signal 继续穿线进 dispatch 内部：入口检查后仍有多个 await 窗口，需在命令
      // 执行与 setDispatcher 前复查，停止后的异步完成不得复活 binding。
      // 拒绝 ≠ 免除所有权：调用方一经调用即移交媒体文件的读取与删除
      // 责任，pre-abort 出口同样必须清理 msg.media 的受管文件，队列入口还须
      // markComplete + waitForIdle 收尾运输（否则 wecom 等渠道落盘文件永久残留）
      dispatch: async (msg, callbacks) => {
        if (signal.aborted) {
          log.warn('dispatch rejected: connector aborted');
          await cleanupInboundMedia(msg.media);
          return EMPTY_RESULT;
        }
        return this.dispatch(bot, msg, callbacks, signal);
      },
      dispatchWithQueue: async (msg, queue) => {
        if (signal.aborted) {
          log.warn('dispatchWithQueue rejected: connector aborted');
          try {
            await cleanupInboundMedia(msg.media);
          } finally {
            queue.markComplete();
            await queue.waitForIdle();
          }
          return EMPTY_RESULT;
        }
        return this.dispatchWithQueue(bot, msg, queue, signal);
      },
      setLateSink: (sink) => {
        if (sink) this.lateSinks.set(bot.id, sink);
        else this.lateSinks.delete(bot.id);
      },
      setStatus: (patch) => {
        log.debug('setStatus: %o', patch);
      },
    };
  }

  // ── 分发 ──────────────────────────────────────────────────────────────

  private async dispatch(
    bot: MessagingConnectionConfig,
    msg: InboundMessage,
    callbacks: DispatchCallbacks,
    signal?: AbortSignal
  ): Promise<DispatchResult> {
    return this.dispatchWithQueue(bot, msg, createDeliveryQueue(callbacks), signal);
  }

  /**
   * 使用外部预建投递队列的分发入口（feishu 等渠道自带 dispatcher 构建逻辑，
   * 经 createReplyDispatcherWithTyping 形状先建队列再分发）。
   * 出站对象统一为 ReplyDispatcher。
   *
   * ownership handoff：一旦进入本方法，msg.media 受管临时文件的
   * 读取与删除责任即转移给 Pipeline——无论命令命中、转换成功/失败还是 inject
   * 抛错，最外层 finally 逐个删除本次受管路径。
   */
  async dispatchWithQueue(
    bot: MessagingConnectionConfig,
    msg: InboundMessage,
    queue: ReplyDispatcher,
    signal?: AbortSignal
  ): Promise<DispatchResult> {
    try {
      return await this.dispatchNormalized(bot, msg, queue, signal);
    } finally {
      await cleanupInboundMedia(msg.media);
    }
  }

  private async dispatchNormalized(
    bot: MessagingConnectionConfig,
    msg: InboundMessage,
    queue: ReplyDispatcher,
    signal?: AbortSignal
  ): Promise<DispatchResult> {
    const { agentService, agentSessions, replyInterceptor, commandRouter } = this.deps;
    if (!agentService || !agentSessions || !replyInterceptor) {
      this.reportRejection(bot.id, 'dependencies_unavailable');
      return EMPTY_RESULT;
    }

    // sender 防御校验：缺失/空白/哨兵值在命令、ask 结算、inject 前拒绝
    if (!hasValidSenderId(msg.senderId)) {
      this.reportRejection(bot.id, 'invalid_sender');
      return deliverDirectFinalReply({ text: SENDER_REJECT_REPLY }, queue);
    }

    const messageText = msg.text || msg.quotedText || '';
    if (!messageText && !msg.media?.length) {
      this.reportRejection(bot.id, 'empty_message');
      return EMPTY_RESULT;
    }

    const conversation = {
      botId: bot.id,
      peerKind: msg.peer.kind,
      peerId: msg.peer.id,
    } as const;
    const resolveLaunch = () => resolveImAgentLaunch(bot, msg.peer).launch;

    // abort 复查：dispatch 入口检查后到此已跨多个 await，
    // 停止后的异步完成不得再执行命令；收尾本次运输后按拒绝形状退出
    if (signal?.aborted) {
      queue.markComplete();
      await queue.waitForIdle();
      return EMPTY_RESULT;
    }

    // 命令分流：在群 sender 信封添加前对渠道最终 messageText 解析；
    // 命中 → 当前 ReplyDispatcher 直接回执并收尾，不 setDispatcher、不 inject
    if (commandRouter) {
      let commandResult;
      try {
        commandResult = await commandRouter.tryExecute(messageText, {
          bot,
          peer: msg.peer,
          senderId: msg.senderId,
          startNewAgent: () => agentSessions.startNew(conversation, resolveLaunch()),
        });
      } catch (error) {
        if (error instanceof ImTaskDefinitionUnavailableError) {
          this.reportRejection(bot.id, 'task_definition_unavailable');
          return deliverDirectFinalReply({ text: TASK_DEFINITION_MISSING_REPLY }, queue);
        }
        queue.markComplete();
        await queue.waitForIdle();
        throw error;
      }
      if (commandResult) {
        return deliverCommandResultDirect(commandResult, queue);
      }
    }

    // 媒体校验/转换在 ensure/inject 之前：任一附件不合规整条拒绝，
    // 不部分消费文本，直接经当前 ReplyDispatcher 回复明确且安全的错误
    let images: InboundImagePayload[] | undefined;
    if (msg.media?.length) {
      const conversion = await validateAndConvertInboundMedia(msg.media);
      if (!conversion.ok) {
        this.reportRejection(bot.id, `media_${conversion.reason}`);
        return deliverDirectFinalReply({ text: conversion.reply }, queue);
      }
      images = conversion.images;
    }

    // 群聊 sender 信封：私聊原样
    const agentText = buildAgentText(msg, messageText);

    let agentId: string;
    try {
      agentId = await agentSessions.ensure(conversation, resolveLaunch);
    } catch (e) {
      if (e instanceof ImTaskDefinitionUnavailableError) {
        this.reportRejection(bot.id, 'task_definition_unavailable');
        return deliverDirectFinalReply({ text: TASK_DEFINITION_MISSING_REPLY }, queue);
      }
      // AgentService 异常在完成运输收尾后继续上抛，不 fallback、不重试
      queue.markComplete();
      await queue.waitForIdle();
      throw e;
    }

    // abort 复查：ensure 期间被停止 → 不安装 dispatcher、不
    // inject，停止后的排队回调不得把 binding 重新装回 ReplyInterceptor（停止不复活）
    if (signal?.aborted) {
      queue.markComplete();
      await queue.waitForIdle();
      return EMPTY_RESULT;
    }

    // 注入前把当前渠道 dispatcher 安装为该 agentId 的最新出口（latest-message-wins）
    replyInterceptor.setDispatcher(agentId, bot.id, queue, bot.replyForward);

    // ask_user 待答由消费侧统一配对：IM 自由文本原样进 tool_result，无短路；
    // 图片走正式 AgentInputEvent.images；IM 与输入框事件从 inject 起形状
    // 一致：channel/peer/sender/fromIM 等 metadata 不进入 AgentInputEvent
    const agentInputEvent = {
      id: `im-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      timestamp: new Date(),
      source: 'user' as const,
      content: agentText,
      priority: 'normal' as const,
      ...(images?.length ? { images } : {}),
    };

    // Agent 运输段：inject false、inject 抛错、yield、timeout、
    // binding_removed 五条出口都且只执行一次本次 queue.markComplete()/waitForIdle()；
    // inject false/抛错先按对象身份 CAS 清理由本次 dispatch 安装的陈旧 binding，
    // 不跨世代重投；抛错在收尾后保留原异常上抛
    let completion: DispatchYieldOutcome | 'inject_rejected';
    try {
      let accepted: boolean;
      try {
        accepted = await agentService.injectEventToAgent(agentId, agentInputEvent);
      } catch (error) {
        replyInterceptor.removeBindingIfCurrent(agentId, bot.id, queue);
        throw error;
      }

      if (!accepted) {
        replyInterceptor.removeBindingIfCurrent(agentId, bot.id, queue);
        completion = 'inject_rejected';
      } else {
        completion = await replyInterceptor.waitForNextYield(agentId);
      }
    } finally {
      queue.markComplete();
      await queue.waitForIdle();
    }

    // 迟到帧兜底：agent 多回合工作时最终答案可能在分发窗口关闭后才产出，
    // 部分渠道的 dispatcher（feishu 流式卡片）会丢弃迟到帧——切换为渠道注册的
    // 主动发送兜底；必须经 replaceDispatcherIfCurrent 对象身份 CAS：
    // binding 已删除或 dispatcher 已被新消息替换时 no-op，不复活/不覆盖
    const lateSink = this.lateSinks.get(bot.id);
    if (lateSink) {
      const peer = { ...msg.peer };
      replyInterceptor.replaceDispatcherIfCurrent(
        agentId,
        bot.id,
        queue,
        createDeliveryQueue({ deliver: (payload) => lateSink(payload, peer) }),
        bot.replyForward
      );
    }

    return { kind: 'agent', completion, counts: queue.getQueuedCounts() };
  }

  // ── 配对 ──────────────────────────────────────────────────────────────

  private buildPairingApi(bot: MessagingConnectionConfig): PairingApi {
    return {
      getAllowedSenders: () => this.deps.authorization?.allowedSenderIds(bot.id) ?? [],

      request: ({ senderId, senderName, peerType, peerId }) => {
        const authorization = this.deps.authorization;
        if (!authorization) throw new Error('Sender authorization registry is unavailable');
        return authorization.requestAuthorization({
          botId: bot.id,
          botName: bot.name,
          channel: bot.channelType,
          senderId,
          senderName,
          peerType,
          peerId,
        });
      },

      buildReply: ({ idLine, code }) => `${idLine}\n配对码: ${code}\n请联系管理员完成授权。`,
    };
  }

  private reportRejection(botId: string, reason: string): void {
    const key = `${botId}:${reason}`;
    const now = Date.now();
    const lastReportedAt = this.rejectionReportedAt.get(key);
    if (lastReportedAt !== undefined && now - lastReportedAt < 60_000) return;
    this.rejectionReportedAt.set(key, now);
    appLog.warn({
      event: 'messaging.inbound.dispatch.rejected',
      message: 'Inbound message rejected',
      context: { scope: 'messaging.inbound', botId, reason },
    });
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────

function buildLogger(_bot: MessagingConnectionConfig): ConnectorLogger {
  return {
    info: (..._args) => undefined,
    warn: (..._args) => undefined,
    error: (..._args) => undefined,
    debug: (..._args) => undefined,
  };
}

/** 进站媒体落盘（收编自 ChannelRuntimeAdapter.buildMediaNamespace） */
function buildMediaApi(): MediaApi {
  return {
    // contentType 诚实可选：vendor 无法预判 MIME 时传 undefined，
    // 未知类型安全落为 .bin；最终是否可注入由 Pipeline magic 检测决定
    saveBuffer: async (buffer, contentType, _subdir, maxBytes, filename) => {
      if (maxBytes && buffer.length > maxBytes) {
        throw new Error(`Media exceeds max size (${buffer.length} > ${maxBytes})`);
      }
      const extFromName = filename ? path.extname(filename).replace(/^\./, '') : '';
      const extFromType = contentType?.includes('/') ? contentType.split('/')[1] : '';
      const ext = extFromName || extFromType || 'bin';
      const filePath = path.join(getManagedMediaDir(), `${createUuid()}.${ext}`);
      fs.writeFileSync(filePath, buffer);
      return { path: filePath, size: buffer.length, contentType };
    },
  };
}
