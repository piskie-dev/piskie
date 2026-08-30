/**
 * AgentInputEvent IPC production-boundary validation:
 * 事件内容正确性在生产边界保证——渲染进程经 IPC 注入的事件在 handler 入口
 * safeParse，失败以 IPC error response 返回，不进 Mailbox（post 保持全函数）。
 *
 * 形状与 AgentInputRequest（shared/types）一致：id/timestamp 可缺省，
 * timestamp 容忍 Date / ISO 字符串 / 毫秒数（与 normalizeAgentInputEvent 的归一化语义对齐）。
 */

import { z } from 'zod';

const agentInputSourceSchema = z.enum([
  'user',
  'api',
  'webhook',
  'system',
  'browser',
  'module',
  'parent',
  'subagent',
]);

/**
 * timestamp 必须可构造为有效时间：任意字符串会经 normalizeAgentInputEvent
 * 产出 Invalid Date，下游 toISOString() 抛 RangeError 杀掉整个冲程——
 * 这正是"内容性错误不得越过生产边界"要拦的东西。
 * z.date() 本身拒绝 Invalid Date 实例。
 */
const timestampSchema = z.union([
  z.date(),
  z.string().refine((v) => Number.isFinite(Date.parse(v)), { message: 'timestamp 字符串必须是可解析的日期' }),
  z.number().finite(),
]);

/**
 * uiSubmission 生产边界：判别联合——未知 kind、非数组、非字符串成员
 * 在 IPC 边界被拒绝，不进 Mailbox。主 agent 与 subagent 两个 inject handler
 * 复用同一 agentInputRequestSchema，不各写一份判断。
 */
const uiSubmissionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask_user_answer'),
    answers: z.array(z.string()),
  }),
]);

export const agentInputRequestSchema = z.object({
  id: z.string().min(1).optional(),
  timestamp: timestampSchema.optional(),
  source: agentInputSourceSchema,
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  images: z
    .array(
      z.object({
        data: z.string().min(1),
        media_type: z.string().min(1),
      }),
    )
    .optional(),
  uiSubmission: uiSubmissionSchema.optional(),
});
