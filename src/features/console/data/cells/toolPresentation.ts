/**
 * 工具展示描述符：**一个工具的展示策略只在这里出现一次**。
 *
 * 这些知识按能力切散开的话（摘要名单一处、内联图片判断一处、计数一处），给一个工具加
 * 展示能力要改四处、漏一处不报错。收进一张表后，加工具只动一行，且能一眼看出它有哪些
 * 展示能力。
 *
 * **只放策略**（布尔与枚举），不放解析函数。工具独有的结果格式解析留在使用处：
 * `generate_image` 的成品路径解析（`- [成功] <path>` 行）在 `toolCell.ts`
 * `extractGeneratedImages`，那是它的实现细节而非展示策略。
 *
 * 按名字匹配的**模式**（`browser_` 前缀、截图工具后缀）不进本表：
 * 那些是域级规则，不随单个工具改名而失效，留在各自的谓词函数里。
 */

export interface ToolPresentation {
  /** 成功结果里的图片直接内联展示，而不是收进 modal */
  /** 活动统计归类（`activity.ts` 的计数口径） */
  readonly activity?: 'image' | 'command' | 'skill';
}

const EMPTY: ToolPresentation = {};

/**
 * 表内是**精确工具名**。工具改名时必须同步此表；集中一处可以让改名只需要扫一个地方。
 */
const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentation>> = {
  skill_call: { activity: 'skill' },
  generate_image: { activity: 'image' },
  shell: { activity: 'command' },
};

export function presentationOf(tool: string | undefined): ToolPresentation {
  return (tool && TOOL_PRESENTATION[tool]) || EMPTY;
}

/** Fixed browser functions share browser_, while Browser Skill authoring tools use browser_skill_. */
export function isBrowserToolName(tool: string | undefined): boolean {
  return Boolean(tool?.startsWith('browser_') && !tool.startsWith('browser_skill_'));
}
