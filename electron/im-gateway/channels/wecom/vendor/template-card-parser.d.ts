/**
 * 模板卡片解析器
 *
 * 从 LLM 回复文本中提取 markdown JSON 代码块，验证其是否为合法的企业微信模板卡片，
 * 返回提取到的卡片列表和剩余文本。
 *
 * 同时提供 maskTemplateCardBlocks 函数，用于在流式中间帧中隐藏正在构建的卡片代码块，
 * 避免 JSON 源码暴露给终端用户。
 */
import type { TemplateCardExtractionResult } from "./interface.js";
/**
 * 从文本中提取模板卡片 JSON 代码块
 *
 * 匹配规则：
 * 1. 匹配所有 ```json ... ``` 或 ``` ... ``` 格式的代码块
 * 2. 尝试 JSON.parse 解析代码块内容
 * 3. 检查解析结果中是否包含合法的 card_type 字段
 * 4. 合法的卡片从原文中移除，不合法的保留
 *
 * @param text - LLM 回复的完整文本
 * @returns 提取结果，包含卡片列表和剩余文本
 */
export declare function extractTemplateCards(text: string, log?: (...args: any[]) => void): TemplateCardExtractionResult;
/**
 * 遮罩文本中的模板卡片代码块（用于流式中间帧展示）
 *
 * 在 LLM 流式输出过程中，累积文本可能包含：
 * 1. 已闭合的模板卡片 JSON 代码块 → 替换为友好提示文本
 * 2. 正在构建中的未闭合代码块 → 截断隐藏，避免 JSON 源码暴露
 *
 * 此函数仅做文本替换，不做 JSON 解析验证（中间帧性能优先）。
 * 只要代码块内容中出现 "card_type" 关键词就认为是模板卡片并遮罩。
 *
 * @param text - 当前累积文本
 * @returns 遮罩后的展示文本
 */
export declare function maskTemplateCardBlocks(text: string, log?: (...args: any[]) => void): string;
