/**
 * 企业微信 WebSocket 监控器主模块
 *
 * 负责：
 * - 建立和管理 WebSocket 连接
 * - 协调消息处理流程（解析→策略检查→下载图片→路由回复）
 * - 资源生命周期管理
 *
 * 子模块：
 * - message-parser.ts  : 消息内容解析
 * - message-sender.ts  : 消息发送（带超时保护）
 * - media-handler.ts   : 图片下载和保存（带超时保护）
 * - group-policy.ts    : 群组访问控制
 * - dm-policy.ts       : 私聊访问控制
 * - state-manager.ts   : 全局状态管理（带 TTL 清理）
 * - timeout.ts         : 超时工具
 */
import type { WeComMonitorOptions } from "./interface.js";
export type { WeComMonitorOptions } from "./interface.js";
export { WeComCommand } from "./const.js";
export { getWeComWebSocket, setReqIdForChat, getReqIdForChatAsync, getReqIdForChat, deleteReqIdForChat, warmupReqIdStore, flushReqIdStore, } from "./state-manager.js";
export { sendWeComReply } from "./message-sender.js";
/**
 * 监听企业微信 WebSocket 连接
 * 使用 aibot-node-sdk 简化连接管理
 */
export declare function monitorWeComProvider(options: WeComMonitorOptions): Promise<void>;
