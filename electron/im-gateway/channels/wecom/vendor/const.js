/**
 * 企业微信渠道常量定义
 */
/**
 * 企业微信渠道 ID
 */
const CHANNEL_ID = "wecom";
/**
 * 企业微信 WebSocket 命令枚举
 */
var WeComCommand;
(function (WeComCommand) {
    /** 认证订阅 */
    WeComCommand["SUBSCRIBE"] = "aibot_subscribe";
    /** 心跳 */
    WeComCommand["PING"] = "ping";
    /** 企业微信推送消息 */
    WeComCommand["AIBOT_CALLBACK"] = "aibot_callback";
    /** clawdbot 响应消息 */
    WeComCommand["AIBOT_RESPONSE"] = "aibot_response";
})(WeComCommand || (WeComCommand = {}));
// ============================================================================
// 超时和重试配置
// ============================================================================
/** 图片下载超时时间（毫秒） */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
/** 文件下载超时时间（毫秒） */
const FILE_DOWNLOAD_TIMEOUT_MS = 60000;
/** 消息发送超时时间（毫秒） */
const REPLY_SEND_TIMEOUT_MS = 15000;
/** WebSocket 心跳间隔（毫秒） */
const WS_HEARTBEAT_INTERVAL_MS = 30000;
/** WebSocket 连接断开时的最大重连次数 */
const WS_MAX_RECONNECT_ATTEMPTS = 10;
/** WebSocket 认证失败时的最大重试次数 */
const WS_MAX_AUTH_FAILURE_ATTEMPTS = 5;
// ============================================================================
// 消息状态管理配置
// ============================================================================
/** messageStates Map 条目的最大 TTL（毫秒），防止内存泄漏 */
const MESSAGE_STATE_TTL_MS = 10 * 60 * 1000;
/** messageStates Map 清理间隔（毫秒） */
const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60000;
/** messageStates Map 最大条目数 */
const MESSAGE_STATE_MAX_SIZE = 500;
// ============================================================================
// 消息模板
// ============================================================================
/** "思考中"流式消息占位内容 */
const THINKING_MESSAGE = "<think></think>";
/** 仅包含图片时的消息占位符 */
const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";
/** 仅包含文件时的消息占位符 */
const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";
// ============================================================================
// 默认值
// ============================================================================
// ============================================================================
// MCP 配置
// ============================================================================
/** 获取 MCP 配置的 WebSocket 命令 */
const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";
/** MCP 配置拉取超时时间（毫秒） */
const MCP_CONFIG_FETCH_TIMEOUT_MS = 15000;
// ============================================================================
// 默认值
// ============================================================================
/** 默认媒体大小上限（MB） */
const DEFAULT_MEDIA_MAX_MB = 5;
/** 文本分块大小上限 */
const TEXT_CHUNK_LIMIT = 4000;
// ============================================================================
// 媒体上传相关常量
// ============================================================================
/** 图片大小上限（字节）：10MB */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 视频大小上限（字节）：10MB */
const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
/** 语音大小上限（字节）：2MB */
const VOICE_MAX_BYTES = 2 * 1024 * 1024;
/** 文件大小上限（字节）：20MB */
const FILE_MAX_BYTES = 20 * 1024 * 1024;
/** 文件绝对上限（字节）：超过此值无法发送，等于 FILE_MAX_BYTES */
const ABSOLUTE_MAX_BYTES = FILE_MAX_BYTES;
// ============================================================================
// 事件/命令名称常量
// ============================================================================
/** 版本检查事件名称（SDK 事件监听用） */
const EVENT_ENTER_CHECK_UPDATE = "event.enter_check_update";
/** 版本检查事件回复命令名称 */
const CMD_ENTER_EVENT_REPLY = "ww_ai_robot_enter_event";
// ============================================================================
// SDK 连接配置
// ============================================================================
/** WSClient scene 参数：企微 OpenClaw 场景 */
const SCENE_WECOM_OPENCLAW = 1;
// ============================================================================
// 模板卡片配置
// ============================================================================
/** 合法的模板卡片 card_type 列表 */
const VALID_CARD_TYPES = [
    "text_notice",
    "news_notice",
    "button_interaction",
    "vote_interaction",
    "multiple_interaction",
];

export { ABSOLUTE_MAX_BYTES, CHANNEL_ID, CMD_ENTER_EVENT_REPLY, DEFAULT_MEDIA_MAX_MB, EVENT_ENTER_CHECK_UPDATE, FILE_DOWNLOAD_TIMEOUT_MS, FILE_MAX_BYTES, IMAGE_DOWNLOAD_TIMEOUT_MS, IMAGE_MAX_BYTES, MCP_CONFIG_FETCH_TIMEOUT_MS, MCP_GET_CONFIG_CMD, MEDIA_DOCUMENT_PLACEHOLDER, MEDIA_IMAGE_PLACEHOLDER, MESSAGE_STATE_CLEANUP_INTERVAL_MS, MESSAGE_STATE_MAX_SIZE, MESSAGE_STATE_TTL_MS, REPLY_SEND_TIMEOUT_MS, SCENE_WECOM_OPENCLAW, TEXT_CHUNK_LIMIT, THINKING_MESSAGE, VALID_CARD_TYPES, VIDEO_MAX_BYTES, VOICE_MAX_BYTES, WS_HEARTBEAT_INTERVAL_MS, WS_MAX_AUTH_FAILURE_ATTEMPTS, WS_MAX_RECONNECT_ATTEMPTS, WeComCommand };
