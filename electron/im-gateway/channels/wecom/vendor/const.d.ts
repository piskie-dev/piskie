/**
 * 企业微信渠道常量定义
 */
/**
 * 企业微信渠道 ID
 */
export declare const CHANNEL_ID: "wecom";
/**
 * 企业微信 WebSocket 命令枚举
 */
export declare enum WeComCommand {
    /** 认证订阅 */
    SUBSCRIBE = "aibot_subscribe",
    /** 心跳 */
    PING = "ping",
    /** 企业微信推送消息 */
    AIBOT_CALLBACK = "aibot_callback",
    /** clawdbot 响应消息 */
    AIBOT_RESPONSE = "aibot_response"
}
/** 图片下载超时时间（毫秒） */
export declare const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
/** 文件下载超时时间（毫秒） */
export declare const FILE_DOWNLOAD_TIMEOUT_MS = 60000;
/** 消息发送超时时间（毫秒） */
export declare const REPLY_SEND_TIMEOUT_MS = 15000;
/** 消息处理总超时时间（毫秒） */
export declare const MESSAGE_PROCESS_TIMEOUT_MS: number;
/** WebSocket 心跳间隔（毫秒） */
export declare const WS_HEARTBEAT_INTERVAL_MS = 30000;
/** WebSocket 连接断开时的最大重连次数 */
export declare const WS_MAX_RECONNECT_ATTEMPTS = 10;
/** WebSocket 认证失败时的最大重试次数 */
export declare const WS_MAX_AUTH_FAILURE_ATTEMPTS = 5;
/** messageStates Map 条目的最大 TTL（毫秒），防止内存泄漏 */
export declare const MESSAGE_STATE_TTL_MS: number;
/** messageStates Map 清理间隔（毫秒） */
export declare const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60000;
/** messageStates Map 最大条目数 */
export declare const MESSAGE_STATE_MAX_SIZE = 500;
/** "思考中"流式消息占位内容 */
export declare const THINKING_MESSAGE = "<think></think>";
/** 仅包含图片时的消息占位符 */
export declare const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";
/** 仅包含文件时的消息占位符 */
export declare const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";
/** 获取 MCP 配置的 WebSocket 命令 */
export declare const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";
/** MCP 配置拉取超时时间（毫秒） */
export declare const MCP_CONFIG_FETCH_TIMEOUT_MS = 15000;
/** 默认媒体大小上限（MB） */
export declare const DEFAULT_MEDIA_MAX_MB = 5;
/** 文本分块大小上限 */
export declare const TEXT_CHUNK_LIMIT = 4000;
/** 图片大小上限（字节）：10MB */
export declare const IMAGE_MAX_BYTES: number;
/** 视频大小上限（字节）：10MB */
export declare const VIDEO_MAX_BYTES: number;
/** 语音大小上限（字节）：2MB */
export declare const VOICE_MAX_BYTES: number;
/** 文件大小上限（字节）：20MB */
export declare const FILE_MAX_BYTES: number;
/** 文件绝对上限（字节）：超过此值无法发送，等于 FILE_MAX_BYTES */
export declare const ABSOLUTE_MAX_BYTES: number;
/** 上传分片大小（字节，Base64 编码前）：512KB */
export declare const UPLOAD_CHUNK_SIZE: number;
/** 版本检查事件名称（SDK 事件监听用） */
export declare const EVENT_ENTER_CHECK_UPDATE = "event.enter_check_update";
/** 版本检查事件回复命令名称 */
export declare const CMD_ENTER_EVENT_REPLY = "ww_ai_robot_enter_event";
/** WSClient scene 参数：企微 OpenClaw 场景 */
export declare const SCENE_WECOM_OPENCLAW = 1;
/** 合法的模板卡片 card_type 列表 */
export declare const VALID_CARD_TYPES: string[];
