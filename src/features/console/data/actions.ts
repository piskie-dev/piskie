/**
 * 动作层（写侧）——**唯一**的 IPC 出口。
 *
 * 全部动作在这里统一成 `target` 化的形状：`{ agentId, workerId? }` 决定走主 agent 还是
 * worker，组件不写 `agentType === 'main' ? … : …`，也不自己拼 `AgentInputEvent`、不自己发 IPC。
 *
 * **结果一律返回，不吞不弹**：动作层不认识 toast，失败信息交给调用方就地回显
 * （错误留在出错的地方）。
 */

import { useCallback, useMemo } from 'react';

import type { AgentInputEvent, ToolApprovalDecision, UiSubmission } from '../../../../shared/types';
import { useRendererRuntime } from '../../../renderer-runtime/hooks';
import {
  messageText,
  presentationFromError,
  rawText,
  type PresentationText,
} from '../../../i18n/presentationText';
import type { GateDecision } from '../content/gates/contract';
import { composeAttachmentText } from '../attachments';

export interface ActionTarget {
  readonly agentId: string;
  /** 有值即投递给该 worker */
  readonly workerId?: string;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly error?: PresentationText;
}

const OK: ActionResult = { ok: true };

export interface MessagePayload {
  readonly text: string;
  readonly images?: readonly { data: string; media_type: string }[];
  readonly files?: readonly { name: string; path: string }[];
  /** 提交旁路：仅 QuestionGate 作答携带，普通 composer 不传 */
  readonly uiSubmission?: UiSubmission;
}

/**
 * 附件文件只把路径拼进正文，提示 AI 用读取工具打开，而不是把内容塞进消息。
 */
function composeContent(payload: MessagePayload): string {
  return composeAttachmentText(
    payload.text,
    payload.files ?? [],
    (payload.images?.length ?? 0) > 0,
  );
}

/** 事件 id 用时间戳即可：服务端不依赖它做去重 */
function buildEvent(payload: MessagePayload): AgentInputEvent {
  return {
    id: `evt-${Date.now()}`,
    timestamp: new Date(),
    source: 'user',
    content: composeContent(payload),
    images:
      payload.images && payload.images.length > 0
        ? payload.images.map(({ data, media_type }) => ({ data, media_type }))
        : undefined,
    uiSubmission: payload.uiSubmission,
  };
}

export interface ConsoleActions {
  /** 发消息（主 agent 或 worker，由 target 决定） */
  readonly send: (target: ActionTarget, payload: MessagePayload) => Promise<ActionResult>;
  /** 审批门/提问门的决定 */
  readonly decide: (target: ActionTarget, decision: GateDecision) => Promise<ActionResult>;
  readonly pause: (target: ActionTarget) => Promise<ActionResult>;
  readonly stop: (agentId: string) => Promise<ActionResult>;
  readonly openWorkspace: (workspace?: string) => Promise<ActionResult>;
  readonly openTrace: (agentId: string) => Promise<ActionResult>;
  readonly deleteHistory: (agentId: string) => Promise<ActionResult>;
  readonly loadHistory: (agentId: string) => Promise<ActionResult>;
  /** 把在跑的工具调用转入后台 */
  readonly promoteToBackground: (callId: string) => Promise<ActionResult>;
}

export function useConsoleActions(): ConsoleActions {
  const { agentCommands, agentRuns } = useRendererRuntime();

  const send = useCallback(async (target: ActionTarget, payload: MessagePayload) => {
    const event = buildEvent(payload);
    try {
      const result = target.workerId
        ? await agentCommands.injectSubagent(target.agentId, target.workerId, event)
        : await agentCommands.inject(target.agentId, event);
      return result.ok ? OK : { ok: false, error: rawText(result.error) };
    } catch (error) {
      return {
        ok: false,
        error: presentationFromError(
          error,
          messageText('sessionWorkbenchUi.action.sendFailed'),
        ),
      };
    }
  }, [agentCommands]);

  const decide = useCallback(
    async (target: ActionTarget, decision: GateDecision): Promise<ActionResult> => {
      // 提问门的"决定"就是一条普通用户消息（答案不携带特殊身份）；
      // 原始答案数组走 uiSubmission 旁路，不进模型正文
      if (decision.kind === 'answer') {
        return send(target, {
          text: decision.answer,
          images: decision.images,
          uiSubmission: { kind: 'ask_user_answer', answers: [...decision.answers] },
        });
      }

      const payload: ToolApprovalDecision =
        decision.kind === 'allow'
          ? {
              callId: decision.callId,
              decision: 'allow',
              changeToAuto: decision.changeToAuto,
            }
          : {
              callId: decision.callId,
              decision: 'deny',
              feedback: decision.feedback,
              images: decision.images ? [...decision.images] : undefined,
            };

      const result = await agentCommands.respondToApproval(
        target.agentId,
        target.workerId,
        payload,
      );
      return result.ok ? OK : { ok: false, error: rawText(result.error) };
    },
    [agentCommands, send],
  );

  const pause = useCallback(
    async (target: ActionTarget): Promise<ActionResult> => {
      const result = target.workerId
        ? await agentCommands.interruptSubagent(target.agentId, target.workerId)
        : await agentCommands.interrupt(target.agentId);
      return result.ok ? OK : { ok: false, error: rawText(result.error) };
    },
    [agentCommands],
  );

  const stop = useCallback(
    async (agentId: string): Promise<ActionResult> => {
      const result = await agentCommands.stop(agentId);
      return result.ok ? OK : { ok: false, error: rawText(result.error) };
    },
    [agentCommands],
  );

  const openWorkspace = useCallback(async (workspace?: string): Promise<ActionResult> => {
    try {
      await window.piskie.desktop.system.openWorkspace(workspace);
      return OK;
    } catch (error) {
      return {
        ok: false,
        error: presentationFromError(
          error,
          messageText('sessionWorkbenchUi.action.openFailed'),
        ),
      };
    }
  }, []);

  const openTrace = useCallback(async (agentId: string): Promise<ActionResult> => {
    try {
      await window.piskie.desktop.system.openAgentRunTrace(agentId);
      return OK;
    } catch (error) {
      return {
        ok: false,
        error: presentationFromError(
          error,
          messageText('sessionWorkbenchUi.action.openFailed'),
        ),
      };
    }
  }, []);

  const deleteHistory = useCallback(
    async (agentId: string): Promise<ActionResult> => {
      try {
        await agentRuns.delete(agentId);
        return OK;
      } catch (error) {
        return {
          ok: false,
          error: presentationFromError(
            error,
            messageText('sessionWorkbenchUi.action.deleteFailed'),
          ),
        };
      }
    },
    [agentRuns],
  );

  const promoteToBackground = useCallback(async (callId: string): Promise<ActionResult> => {
    try {
      const result = await agentCommands.promoteToBackground(callId);
      if (!result.ok) return { ok: false, error: rawText(result.error) };
      return result.value
        ? OK
        : { ok: false, error: messageText('sessionWorkbenchUi.action.promotionUnavailable') };
    } catch (error) {
      return {
        ok: false,
        error: presentationFromError(
          error,
          messageText('sessionWorkbenchUi.action.promotionFailed'),
        ),
      };
    }
  }, [agentCommands]);

  const loadHistory = useCallback(
    async (agentId: string): Promise<ActionResult> => {
      const snapshot = await agentRuns.loadPreview(agentId);
      return snapshot
        ? OK
        : { ok: false, error: messageText('sessionWorkbenchUi.action.historyLoadFailed') };
    },
    [agentRuns],
  );

  return useMemo(
    () => ({
      send, decide, pause, stop, openWorkspace, openTrace, deleteHistory, loadHistory,
      promoteToBackground,
    }),
    [decide, deleteHistory, loadHistory, openTrace, openWorkspace, pause, promoteToBackground, send, stop],
  );
}
