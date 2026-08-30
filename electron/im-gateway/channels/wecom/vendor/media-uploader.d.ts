/**
 * 企业微信出站媒体上传工具模块
 *
 * 负责：
 * - 从 mediaUrl 加载文件 buffer（远程 URL 或本地路径均支持）
 * - 检测 MIME 类型并映射为企微媒体类型
 * - 文件大小检查与降级策略
 */
import type { WeComMediaType, WSClient, WsFrameHeaders } from "@wecom/aibot-node-sdk";
/** 媒体文件解析结果 */
export interface ResolvedMedia {
    /** 文件数据 */
    buffer: Buffer;
    /** 检测到的 MIME 类型 */
    contentType: string;
    /** 文件名（从 URL 提取或默认生成） */
    fileName: string;
}
/** 文件大小检查结果 */
export interface FileSizeCheckResult {
    /** 最终确定的企微媒体类型（可能被降级） */
    finalType: WeComMediaType;
    /** 是否需要拒绝（超过绝对限制） */
    shouldReject: boolean;
    /** 拒绝原因（仅 shouldReject=true 时有值） */
    rejectReason?: string;
    /** 是否发生了降级 */
    downgraded: boolean;
    /** 降级说明（仅 downgraded=true 时有值） */
    downgradeNote?: string;
}
/**
 * 根据 MIME 类型检测企微媒体类型
 *
 * @param mimeType - MIME 类型字符串
 * @returns 企微媒体类型
 */
export declare function detectWeComMediaType(mimeType: string): WeComMediaType;
/**
 * 从 mediaUrl 加载媒体文件
 *
 * 支持远程 URL（http/https）和本地路径（file:// 或绝对路径），
 * 利用 openclaw plugin-sdk 的 loadOutboundMediaFromUrl 统一处理。
 *
 * @param mediaUrl - 媒体文件的 URL 或本地路径
 * @param mediaLocalRoots - 允许读取本地文件的安全白名单目录
 * @returns 解析后的媒体文件信息
 */
export declare function resolveMediaFile(mediaUrl: string, mediaLocalRoots?: readonly string[]): Promise<ResolvedMedia>;
/**
 * 检查文件大小并执行降级策略
 *
 * 降级规则：
 * - voice 非 AMR 格式 → 降级为 file（企微后台仅支持 AMR）
 * - image 超过 10MB → 降级为 file
 * - video 超过 10MB → 降级为 file
 * - voice 超过 2MB → 降级为 file
 * - file 超过 20MB → 拒绝发送
 *
 * @param fileSize - 文件大小（字节）
 * @param detectedType - 检测到的企微媒体类型
 * @param contentType - 文件的 MIME 类型（用于语音格式校验）
 * @returns 大小检查结果
 */
export declare function applyFileSizeLimits(fileSize: number, detectedType: WeComMediaType, contentType?: string): FileSizeCheckResult;
/** uploadAndSendMedia 的参数 */
export interface UploadAndSendMediaOptions {
    /** WSClient 实例 */
    wsClient: WSClient;
    /** 媒体文件的 URL 或本地路径 */
    mediaUrl: string;
    /** 目标会话 ID（用于 aibot_send_msg 主动发送） */
    chatId: string;
    /** 允许读取本地文件的安全白名单目录 */
    mediaLocalRoots?: readonly string[];
    /** 日志函数 */
    log?: (...args: any[]) => void;
    /** 错误日志函数 */
    errorLog?: (...args: any[]) => void;
}
/** uploadAndSendMedia 的返回结果 */
export interface UploadAndSendMediaResult {
    /** 是否发送成功 */
    ok: boolean;
    /** 发送后返回的 messageId */
    messageId?: string;
    /** 最终的企微媒体类型 */
    finalType?: WeComMediaType;
    /** 是否被拒绝（文件过大） */
    rejected?: boolean;
    /** 拒绝原因 */
    rejectReason?: string;
    /** 是否发生了降级 */
    downgraded?: boolean;
    /** 降级说明 */
    downgradeNote?: string;
    /** 错误信息 */
    error?: string;
}
/**
 * 公共媒体上传+发送流程
 *
 * 统一处理：resolveMediaFile → detectType → sizeCheck → uploadMedia → sendMediaMessage
 * 媒体消息统一走 aibot_send_msg 主动发送，避免多文件场景下 reqId 只能用一次的问题。
 * channel.ts 的 sendMedia 和 monitor.ts 的 deliver 回调都使用此函数。
 */
export declare function uploadAndSendMedia(options: UploadAndSendMediaOptions): Promise<UploadAndSendMediaResult>;
/** uploadAndReplyMedia 的参数 */
export interface UploadAndReplyMediaOptions {
    /** WSClient 实例 */
    wsClient: WSClient;
    /** 媒体文件的 URL 或本地路径 */
    mediaUrl: string;
    /** 原始 WebSocket 帧（用于 aibot_respond_msg 被动回复，携带 req_id） */
    frame: WsFrameHeaders;
    /** 允许读取本地文件的安全白名单目录 */
    mediaLocalRoots?: readonly string[];
    /** 日志函数 */
    log?: (...args: any[]) => void;
    /** 错误日志函数 */
    errorLog?: (...args: any[]) => void;
}
/**
 * 被动回复媒体上传+发送流程
 *
 * 统一处理：resolveMediaFile → detectType → sizeCheck → uploadMedia → replyMedia
 * 通过 aibot_respond_msg 被动回复通道发送媒体消息，可以覆盖之前的 THINKING_MESSAGE。
 *
 * 适用场景：回包只有媒体没有文本时，第一个媒体文件用此方法发送以清理 thinking 状态。
 */
export declare function uploadAndReplyMedia(options: UploadAndReplyMediaOptions): Promise<UploadAndSendMediaResult>;
