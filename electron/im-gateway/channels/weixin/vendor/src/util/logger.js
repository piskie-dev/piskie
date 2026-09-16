/**
 * PISKIE 本地改动：插件日志转发到 Piskie 应用日志（<userData>/logs/app），
 * 不再向 OpenClaw 临时目录写 `openclaw-YYYY-MM-DD.log`，也不读取 `OPENCLAW_LOG_LEVEL`。
 *
 * 保留上游 logger 的调用面：info/debug/warn/error/withAccount/close 与 setLogLevel。
 */
import { createVendorLogSink } from "../../../../../core/vendor-log.js";
const SUBSYSTEM = "gateway/channels/openclaw-weixin";
/** tslog-compatible level IDs (higher = more severe). */
const LEVEL_IDS = {
    TRACE: 1,
    DEBUG: 2,
    INFO: 3,
    WARN: 4,
    ERROR: 5,
    FATAL: 6,
};
const DEFAULT_LOG_LEVEL = "INFO";
let minLevelId = LEVEL_IDS[DEFAULT_LOG_LEVEL];
/** Dynamically change the minimum log level at runtime. */
export function setLogLevel(level) {
    const upper = level.toUpperCase();
    if (!(upper in LEVEL_IDS)) {
        throw new Error(`Invalid log level: ${level}. Valid levels: ${Object.keys(LEVEL_IDS).join(", ")}`);
    }
    minLevelId = LEVEL_IDS[upper];
}
const APP_LOG_LEVELS = {
    TRACE: "debug",
    DEBUG: "debug",
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
    FATAL: "error",
};
let sink;
function getSink() {
    if (!sink)
        sink = createVendorLogSink("openclaw-weixin");
    return sink;
}
function buildLoggerName(accountId) {
    return accountId ? `${SUBSYSTEM}/${accountId}` : SUBSYSTEM;
}
function writeLog(level, message, accountId) {
    const levelId = LEVEL_IDS[level] ?? LEVEL_IDS.INFO;
    if (levelId < minLevelId)
        return;
    const loggerName = buildLoggerName(accountId);
    const prefixedMessage = accountId ? `[${accountId}] ${message}` : message;
    try {
        getSink()(APP_LOG_LEVELS[level] ?? "info", prefixedMessage, accountId
            ? { logger: loggerName, accountId }
            : { logger: loggerName });
    }
    catch {
        // Best-effort; never block on logging failures.
    }
}
/** Creates a logger instance, optionally bound to a specific account. */
function createLogger(accountId) {
    return {
        info(message) {
            writeLog("INFO", message, accountId);
        },
        debug(message) {
            writeLog("DEBUG", message, accountId);
        },
        warn(message) {
            writeLog("WARN", message, accountId);
        },
        error(message) {
            writeLog("ERROR", message, accountId);
        },
        withAccount(id) {
            return createLogger(id);
        },
        close() {
            // No-op: the Piskie app log owns the sink lifecycle.
        },
    };
}
export const logger = createLogger();
