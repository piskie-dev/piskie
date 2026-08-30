/**
 * 企业微信全局状态管理模块
 *
 * 负责管理 WSClient 实例、消息状态（带 TTL 清理）、ReqId 存储
 * 解决全局 Map 的内存泄漏问题
 */
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageState } from "./interface.js";
/**
 * 获取指定账户的 WSClient 实例
 */
export declare function getWeComWebSocket(accountId: string): WSClient | null;
/**
 * 设置指定账户的 WSClient 实例
 */
export declare function setWeComWebSocket(accountId: string, client: WSClient): void;
/**
 * 删除指定账户的 WSClient 实例
 */
export declare function deleteWeComWebSocket(accountId: string): void;
/**
 * 启动消息状态定期清理（自动 TTL 清理 + 容量限制）
 */
export declare function startMessageStateCleanup(): void;
/**
 * 停止消息状态定期清理
 */
export declare function stopMessageStateCleanup(): void;
/**
 * 设置消息状态
 */
export declare function setMessageState(messageId: string, state: MessageState): void;
/**
 * 获取消息状态
 */
export declare function getMessageState(messageId: string): MessageState | undefined;
/**
 * 删除消息状态
 */
export declare function deleteMessageState(messageId: string): void;
/**
 * 清空所有消息状态
 */
export declare function clearAllMessageStates(): void;
/**
 * 设置 chatId 对应的 reqId（写入内存 + 防抖写磁盘）
 */
export declare function setReqIdForChat(chatId: string, reqId: string, accountId?: string): void;
/**
 * 获取 chatId 对应的 reqId（异步：优先内存，miss 时查磁盘并回填内存）
 */
export declare function getReqIdForChatAsync(chatId: string, accountId?: string): Promise<string | undefined>;
/**
 * 获取 chatId 对应的 reqId（同步：仅内存，保留向后兼容）
 */
export declare function getReqIdForChat(chatId: string, accountId?: string): string | undefined;
/**
 * 删除 chatId 对应的 reqId
 */
export declare function deleteReqIdForChat(chatId: string, accountId?: string): void;
/**
 * 启动时预热 reqId 缓存（从磁盘加载到内存）
 *
 * 注意：由于移除了磁盘存储，此函数现在只返回 0（无预热条目）
 */
export declare function warmupReqIdStore(accountId?: string, log?: (...args: unknown[]) => void): Promise<number>;
/**
 * 立即将 reqId 数据刷写到磁盘（用于优雅退出）
 *
 * 注意：由于移除了磁盘存储，此函数现在是无操作
 */
export declare function flushReqIdStore(accountId?: string): Promise<void>;
/**
 * 清理指定账户的所有资源
 */
export declare function cleanupAccount(accountId: string): Promise<void>;
/**
 * 清理所有资源（用于进程退出）
 */
export declare function cleanupAll(): Promise<void>;
