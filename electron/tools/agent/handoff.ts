/**
 * 交接段：把材料交给另一个智能体的工具（subagent / agent_run / schedule）共用同一段话，
 * 只替换对象称呼与材料字段名；`isolated` 为 true 时点明对方不知道当前对话。
 */
export function handoffGuidance(
  subject: string,
  material: string,
  options: { isolated?: boolean } = {},
): string {
  const judgement = options.isolated
    ? '它能力完整，可以自主判断，但不知道当前对话和既有进展'
    : '它能力完整，可以自主判断';
  return `把新的${subject}当作一位刚走进房间的聪明同事来交接：${judgement}；${material} 是它拿到的全部材料。`;
}
