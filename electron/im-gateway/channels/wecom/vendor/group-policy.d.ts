/**
 * 企业微信群组访问控制模块
 *
 * 负责群组策略检查（groupPolicy、群组白名单、群内发送者白名单）
 */
import type { RuntimeEnv } from "./compat-types.js";
import type { ResolvedWeComAccount } from "./compat-types.js";
/**
 * 群组策略检查结果
 */
export interface GroupPolicyCheckResult {
    /** 是否允许继续处理消息 */
    allowed: boolean;
}
/**
 * 检查群组策略访问控制
 * @returns 检查结果，包含是否允许继续处理
 */
export declare function checkGroupPolicy(params: {
    chatId: string;
    senderId: string;
    account: ResolvedWeComAccount;
    runtime: RuntimeEnv;
}): GroupPolicyCheckResult;
/**
 * 检查发送者是否在允许列表中（通用）
 */
export declare function isSenderAllowed(senderId: string, allowFrom: string[]): boolean;
