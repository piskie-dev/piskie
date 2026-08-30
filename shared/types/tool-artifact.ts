/**
 * 持久工具产物契约——ToolEntry.artifacts 的唯一公共类型来源。
 *
 * Artifact 表达"已经发生且需要跨重启展示的结构化产物"，不是 Presentation：
 * 后端只提供事实，前端 projector registry 决定视觉形态。
 * 它不属于 ToolResult，不进 renderToolResult()、context projection 或 replay。
 * 新增 kind 时，shared 类型、生产者、前端 registry 应在同一版本
 * 一起更新，缺项由 TypeScript 编译失败暴露。
 */

export type FileDiffArtifactStat = Readonly<{
  linesAdded: number;
  linesDeleted: number;
  linesChanged: number;
}>;

export interface ToolArtifactMap {
  /** edit 成功提交的执行期 unified diff；hunk header 带真实旧/新文件行号 */
  file_diff: Readonly<{
    path: string;
    unifiedDiff: string;
    stat: FileDiffArtifactStat;
  }>;
  /**
   * QuestionGate 提交的逐题原始答案；
   * 顺序与 tool_use.input.questions 一致，原样保存（含换行）。
   */
  ask_user_answers: Readonly<{
    answers: string[];
  }>;
  /** MCP audio has no model-result carrier yet, so it remains a UI-only artifact. */
  mcp_audio: Readonly<{ mimeType: string; dataBase64: string }>;
}

export type ToolArtifactKind = keyof ToolArtifactMap;

export type ToolArtifactOf<K extends ToolArtifactKind> = Readonly<{
  kind: K;
  payload: ToolArtifactMap[K];
}>;

export type ToolArtifact = {
  [K in ToolArtifactKind]: ToolArtifactOf<K>
}[ToolArtifactKind];
