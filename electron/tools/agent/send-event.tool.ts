/**
 * SendEventTool - 统一的事件发送工具
 *
 * 参数拍平：eventData 裸 object → type/message/summary? 平面参数；
 * targetId 改可选（子流程缺省发父）。通过 allowedTargets 控制每个 Agent 可发送的目标。
 */

import { BaseTool } from '../base-tool.js';
import type {
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { z } from '../params.js';
import type { ToolInputSchema } from '../../../shared/types/index.js';
import type { AgentTarget } from '../../../shared/types/agent-control.js';
import type {
  ATAEventEnvelope,
  ATAEventPayload,
} from '../../agent/ata/ata-event-envelope.js';
import { ataEventPayloadStore } from '../../agent/ata/ata-event-payload-store.js';
import { notificationFromATAEventEnvelope } from '../../agent/ata/ata-event-protocol.js';

const EVENT_TYPES = [
  'message',
  'completed',
  'failed',
  'user_stopped',
  'need_user_action',
] as const;

const sendEventSchema = z.object({
  type: z.enum(EVENT_TYPES)
    .describe('事件类型'),
  message: z.string().min(1)
    .describe('完整、自包含的事件正文'),
  summary: z.string().optional()
    .describe('一句话摘要（可选）'),
  targetId: z.string().optional()
    .describe('接收消息的完整 Worker ID'),
});
type SendEventParams = z.infer<typeof sendEventSchema>;

function roleSpecificSchema(
  schema: ToolInputSchema,
  agentType: 'main' | 'worker',
): ToolInputSchema {
  const summary = schema.properties.summary ?? {};
  if (agentType === 'main') {
    return {
      ...schema,
      properties: {
        type: {
          type: 'string',
          const: 'message',
          description: '固定为 message',
        },
        targetId: {
          ...(schema.properties.targetId as Record<string, unknown>),
          description: '接收消息的完整 subagentId（由 subagent 创建结果返回）',
        },
        message: {
          ...(schema.properties.message as Record<string, unknown>),
          description: '发送给 Worker 的完整、自包含更新',
        },
        summary,
      },
      required: ['type', 'targetId', 'message'],
      additionalProperties: false,
    };
  }

  return {
    ...schema,
    properties: {
      type: {
        ...(schema.properties.type as Record<string, unknown>),
        enum: [...EVENT_TYPES],
        description: 'message 为普通报告；completed、failed、user_stopped 为终态；need_user_action 表示需要用户介入',
      },
      message: {
        ...(schema.properties.message as Record<string, unknown>),
        description: '发给 Director 的完整、自包含报告',
      },
      summary,
    },
    required: ['type', 'message'],
    additionalProperties: false,
  };
}

const DIRECTOR_DESCRIPTION = `向正在运行的 Worker 发送新的信息或要求。只发送 type="message"，并指定目标 Worker 的完整 subagentId。

message 应完整说明变化后的目标、范围、约束以及继续执行所需事实。send_event 必须单独调用，不得与其他工具混在同一响应中。

任务范围变化示例：
\`send_event({ type: "message", targetId: "<subagentId>", message: "保留已经完成并验证的部分。新增要求是……；新的范围边界是……；接下来按……验收并回报。" })\``;

const WORKER_DESCRIPTION = `向 Director 报告 Assignment 状态或请求用户介入。

- message：发送不结束 Assignment 的普通报告。
- completed：当前 Assignment 的全部要求已经完成；message 写明关键结果、产出路径和验证结论。
- failed：当前 Assignment 无法完成；message 写明原因、原始错误、已完成部分和未完成项。
- user_stopped：用户明确停止当前 Assignment。
- need_user_action：登录、验证码、授权确认或用户选择等只有用户能解除的阻断；message 写明当前状态、用户要做的动作、解除阻断的可观察标志和恢复点。

completed、failed 或 user_stopped 发送成功后，结束当前响应并等待新输入；之后收到新的用户要求或 Director 消息时，继续按新要求处理。need_user_action 发送成功后结束当前响应，等待 Director 转达用户结果，不要轮询。

send_event 必须单独调用，不得与其他工具混在同一响应中。

需要用户介入的示例：
\`send_event({ type: "need_user_action", message: "当前停在登录页。请完成登录；出现工作台首页即表示阻断解除。收到确认后，我会先验证登录状态，再从提交前的检查点继续。" })\``;

export class SendEventTool extends BaseTool<SendEventParams> {
  readonly def: ToolDef<SendEventParams> = {
    name: 'send_event',
    scope: 'shared',
    effects: ['agent-control'],
    schema: sendEventSchema,
    modelInputSchema: (schema, context) => roleSpecificSchema(schema, context.agentType),
    policy: { exclusive: true },
    description: (agentType) => agentType === 'worker'
      ? WORKER_DESCRIPTION
      : DIRECTOR_DESCRIPTION,
  };

  async execute(
    params: SendEventParams,
    context: ToolContext,
  ): Promise<ToolOutput<unknown>> {
    const { type, message, summary } = params;
    let targetId: string;

    if (!message) {
      return this.error('发送事件需要: message');
    }

    const allowedTargets = [...(context.events?.allowedTargets() ?? [])];

    if (context.agentType === 'worker') {
      if (params.targetId !== undefined) {
        return this.error('Worker 发送事件时不能指定 targetId');
      }
      if (allowedTargets.length === 0) {
        return this.error('当前没有可接收事件的 Director');
      }
      targetId = allowedTargets[0];
    } else {
      if (type !== 'message') {
        return this.error('Director 只能发送 type="message"');
      }
      targetId = params.targetId?.trim() ?? '';
      if (!targetId) {
        return this.error('director 发送事件必须指定完整 subagentId');
      }
    }

    const eventData: ATAEventPayload = {
      type,
      message,
      ...(summary ? { summary } : {}),
    };

    if (!allowedTargets.includes(targetId)) {
      return this.error(
        `无权限发送事件到目标: ${targetId}。允许的目标: ${allowedTargets.join(', ') || '无'}`
      );
    }

    // ATA Envelope: 统一封装所有 eventData（超长 message 自动落盘）
    const source: AgentTarget = context.agentType === 'worker'
      ? { agentId: context.mainAgentId, workerId: context.agentId }
      : { agentId: context.mainAgentId };
    const envelope = await ataEventPayloadStore.prepareEnvelope(source, eventData);

    // 根据 Agent 类型选择发送方式
    if (context.agentType === 'worker') {
      return this.sendToParent(targetId, envelope, context);
    } else {
      return this.sendToSubagent(targetId, envelope, context);
    }
  }

  /**
   * Subagent 发送事件给 MainAgent
   */
  private sendToParent(
    targetId: string,
    envelope: ATAEventEnvelope,
    context: ToolContext,
  ): ToolOutput<unknown> {
    if (!context.events) {
      return this.error('onNotification 回调未配置');
    }

    // 从 envelope 提取 type，构建通知（envelope 作为 notification.data）
    const notification = notificationFromATAEventEnvelope(envelope);
    const delivered = context.events.notifyParent(notification);

    // 投递守门：只有实际送达才产生 terminal——
    // 否则 worker 结束冲程而父流程永远收不到 completed，恰是要消灭的悬挂 bug
    if (!delivered) {
      return this.error(
        `事件未送达 director（targetId: ${targetId} 已停止或销毁），任务状态未上报。请勿假设通知已送达。`
      );
    }

    // 终态类型送达后声明终态；need_user_action 的 yield 由成功结算后
    // 派生出的 user_action IdlePermit 驱动，不结束 Assignment。
    const isTerminal = envelope.type === 'completed' || envelope.type === 'failed' || envelope.type === 'user_stopped';
    if (isTerminal) {
      context.declareTerminal(envelope.type as import('../types.js').TerminalReason);
      return this.success(
        `send_event(type: "${envelope.type}") 已成功发送到 director（targetId: ${targetId}）。当前任务的 ${envelope.type} 通知已送达，等待新的指令。`,
      );
    }
    if (envelope.type === 'need_user_action') {
      return this.success(
        `send_event(type: "need_user_action") 已成功发送到 director（targetId: ${targetId}）。当前执行将挂起，等待 director 转达用户已完成操作的消息。`,
      );
    }
    return this.success(`已发送事件到 ${targetId}: ${envelope.type}`);
  }

  /**
   * MainAgent 发送事件给 Subagent
   */
  private sendToSubagent(
    targetId: string,
    envelope: ATAEventEnvelope,
    context: ToolContext,
  ): ToolOutput<unknown> {
    if (!context.events) {
      return this.error('sendEventToSubagent 回调未配置');
    }

    // 投递守门：post 返回 false = 子流程已停止/销毁，事件未入队
    const delivered = context.events.send(targetId, envelope as unknown as Record<string, unknown>);
    if (!delivered) {
      return this.error(
        `事件未送达子流程（targetId: ${targetId} 不存在、已停止或已销毁）。请勿假设事件已送达。`
      );
    }
    return this.success(`事件已发送到子流程: ${targetId}。`);
  }

}
