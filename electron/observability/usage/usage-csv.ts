import type { AppSettings } from '../../../shared/types/index.js';
import type { UsageRecord, UsageStatus } from '../../../shared/types/model-usage.js';

type Language = AppSettings['language'];
type Label = Record<Language, string>;
type Column = { label: Label; value(record: UsageRecord, language: Language): unknown };

export const usageExportTitle: Label = { 'zh-CN': '导出模型用量', 'en-US': 'Export model usage' };
const purposes: Record<UsageRecord['purpose'], Label> = {
  inference: { 'zh-CN': '推理', 'en-US': 'Inference' },
  compaction: { 'zh-CN': '上下文压缩', 'en-US': 'Compaction' },
  test: { 'zh-CN': '模型测试', 'en-US': 'Model test' },
};
const statuses: Record<UsageStatus, Label> = {
  running: { 'zh-CN': '进行中', 'en-US': 'Running' },
  success: { 'zh-CN': '成功', 'en-US': 'Success' },
  failed: { 'zh-CN': '失败', 'en-US': 'Failed' },
  cancelled: { 'zh-CN': '已取消', 'en-US': 'Cancelled' },
  interrupted: { 'zh-CN': '中断 · 结果未知', 'en-US': 'Interrupted · outcome unknown' },
};

const columns: readonly Column[] = [
  { label: { 'zh-CN': '调用时间（UTC）', 'en-US': 'Call time (UTC)' }, value: (r) => new Date(r.startedAt).toISOString() },
  { label: { 'zh-CN': '会话 / 任务 ID', 'en-US': 'Session / task ID' }, value: (r) => r.mainAgentId },
  { label: { 'zh-CN': '会话 / 任务名称', 'en-US': 'Session / task name' }, value: (r) => r.runName },
  { label: { 'zh-CN': 'Agent 实例 ID', 'en-US': 'Agent instance ID' }, value: (r) => r.agentId },
  { label: { 'zh-CN': 'Agent 类型', 'en-US': 'Agent type' }, value: (r) => r.agentType },
  { label: { 'zh-CN': '用途', 'en-US': 'Purpose' }, value: (r, language) => purposes[r.purpose][language] },
  { label: { 'zh-CN': 'Provider 名称', 'en-US': 'Provider name' }, value: (r) => r.providerName },
  { label: { 'zh-CN': 'Provider ID', 'en-US': 'Provider ID' }, value: (r) => r.providerId },
  { label: { 'zh-CN': '模型名称', 'en-US': 'Model name' }, value: (r) => r.modelName },
  { label: { 'zh-CN': '模型 ID', 'en-US': 'Model ID' }, value: (r) => r.modelId },
  { label: { 'zh-CN': '状态', 'en-US': 'Status' }, value: (r, language) => statuses[r.status][language] },
  { label: { 'zh-CN': '逻辑请求 ID', 'en-US': 'Logical request ID' }, value: (r) => r.requestId },
  { label: { 'zh-CN': '网关运行 ID', 'en-US': 'Gateway run ID' }, value: (r) => r.runId },
  { label: { 'zh-CN': '尝试序号', 'en-US': 'Attempt number' }, value: (r) => r.attempt },
  { label: { 'zh-CN': '输入 Token（含缓存）', 'en-US': 'Input tokens (including cache)' }, value: (r) => r.usage.totalInputTokens },
  { label: { 'zh-CN': '输出 Token（含推理）', 'en-US': 'Output tokens (including reasoning)' }, value: (r) => r.usage.totalOutputTokens },
  { label: { 'zh-CN': '缓存读取 Token', 'en-US': 'Cache read tokens' }, value: (r) => r.usage.cachedInputTokens },
  { label: { 'zh-CN': '缓存写入 Token', 'en-US': 'Cache write tokens' }, value: (r) => r.usage.cacheWriteTokens },
  { label: { 'zh-CN': '推理 Token', 'en-US': 'Reasoning tokens' }, value: (r) => r.usage.reasoningTokens },
  { label: { 'zh-CN': '首响应耗时（毫秒）', 'en-US': 'First response (ms)' }, value: (r) => r.firstResponseMs },
  { label: { 'zh-CN': '总耗时（毫秒）', 'en-US': 'Total duration (ms)' }, value: (r) => r.endedAt === undefined ? undefined : r.endedAt - r.startedAt },
];

export function formatUsageCsv(records: readonly UsageRecord[], language: Language): string {
  const header = columns.map((column) => column.label[language]);
  const rows = records.map((record) => columns.map((column) => column.value(record, language)));
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: unknown): string {
  let text = value === undefined ? '' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
