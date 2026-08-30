/**
 * Token 相关常量
 */

/**
 * 上下文窗口准入下限（token 数）。
 *
 * 依据：系统提示词 + 工具定义的固定开销约 38k，再留至少 12k 对话空间。
 * 低于这个量级的模型本项目跑不起来——与其让它跑起来再溢出，不如在表单里就填不进去。
 * 这不是「缺失时的兜底」：`contextWindow` 是必填项，此处只做下限钳制。
 */
export const MIN_CONTEXT_WINDOW = 50000;

/**
 * 单张图片对 token 上界的贡献。
 *
 * 请求前的准入用「字符数是 token 数的严格上界」这条数学事实，但 base64 图片
 * 一张就有上百万字符、实际只值几千 token，按字符算会让每个带图轮次都掉进二级。
 * provider 对单张图片有文档写死的上限（Anthropic 长边封顶 2576 ⇒ 单张不超过约 8,850），
 * 用它作为图片块的上界贡献——同样是严格上界，但紧得多。
 */
export const IMAGE_TOKEN_UPPER_BOUND = 8850;

/**
 * 单条 tool_result 的字节配额。
 *
 * 这是一条防御性配额，不是正确性要求，因此不需要精确到 token；
 * 量纲用精确可测的字节，避免为它引入一个估算器。
 */
export const MAX_TOOL_RESULT_BYTES = 120_000;

/**
 * Token 使用警告阈值（百分比）
 */
export const TOKEN_WARNING_THRESHOLDS = {
  /** 低警告阈值 - 50% */
  low: 50,
  /** 中警告阈值 - 75% */
  medium: 75,
  /** 高警告阈值 - 90% */
  high: 90,
} as const;
