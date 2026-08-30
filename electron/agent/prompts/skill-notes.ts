/**
 * L4 skill-notes：技能/工具文档注入
 * 由 Identity.includeSkillDocs 决定是否注入。
 * 出口裁剪（stripPromptOmitSections）在 pilot-manager 的 loadSkillDocs 出口做，
 * 本层拿到的 docs 即最终注入文本。
 */

export function skillNotes(docs: string): string {
  if (!docs || !docs.trim()) return '';
  return `## 技能与工具文档

${docs}`;
}
