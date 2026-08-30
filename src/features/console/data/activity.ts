/**
 * 活动徽标 —— 把一条流水的工具调用聚合成一小组"干了多少活"的计数
 * （共享任务清单的 ± 行数与活动量）。
 *
 * ## 口径
 *
 * - **只数成功**（`state.phase === 'ok'`）：失败/取消的调用没有产出
 * - 成果类：文件改动 ±行数（与审阅面板同源 `diffLines`，数字必须一致）、生图张数
 * - 活动量类：浏览器动作步数（**排除截图与等待** —— 那是观察不是动作）、
 *   命令次数、技能调用次数
 * - `read` / `grep` / `send_event` 这类纯过程不进徽标 —— 噪音
 * - 技能**内部**做了什么不可见（skill_call 是黑盒），只能计次 —— 这是诚实边界，
 *   不装作能数到里面
 *
 * ## 归属边界
 *
 * 本函数只聚合**给它的 nodes**。按谁的流水算就是谁的活动：
 * - 会话级总量：当前视图的流水（ThreadView 传 `transcript.nodes`）
 * - 单任务 worker：它整条流水的活动就是那个任务的活动（`worker.taskIds.length === 1`
 *   时归属是事实，不是推断）
 * - 主流水任务 / 多任务 worker：工具调用没有明确的任务标记时**不显示**，
 *   避免把活动量错误归给某个任务
 */

import type { TranscriptNode } from '@/domains/transcript/nodes';
import { isBrowserToolName, presentationOf } from './cells/toolPresentation';
import { diffLines } from './diffLines';

export interface ActivityChips {
  /** 文件改动行数（write 全量按新增计，edit 按 LCS diff 计 —— 与审阅面板一致） */
  readonly added: number;
  readonly removed: number;
  /** 成功生图张数 */
  readonly images: number;
  /** 浏览器动作步数（不含截图/等待） */
  readonly browserSteps: number;
  /** shell 命令次数 */
  readonly commands: number;
  /** 技能调用次数（内部动作不可见，只计次） */
  readonly skillCalls: number;
}

export const EMPTY_ACTIVITY: ActivityChips = {
  added: 0,
  removed: 0,
  images: 0,
  browserSteps: 0,
  commands: 0,
  skillCalls: 0,
};

export function hasActivity(chips: ActivityChips): boolean {
  return (
    chips.added > 0 ||
    chips.removed > 0 ||
    chips.images > 0 ||
    chips.browserSteps > 0 ||
    chips.commands > 0 ||
    chips.skillCalls > 0
  );
}

/** 观察类后缀：不算"动作"（takeScreenshot / wait）。 */
const OBSERVATION = /screenshot|_wait$/i;

export function activityChips(nodes: readonly TranscriptNode[]): ActivityChips {
  let added = 0;
  let removed = 0;
  let images = 0;
  let browserSteps = 0;
  let commands = 0;
  let skillCalls = 0;

  for (const node of nodes) {
    if (node.kind !== 'tool' || node.state.phase !== 'ok') continue;

    const op = node.fileOp;
    if (op?.kind === 'write') {
      const stat = diffLines('', op.content).stat;
      added += stat.added;
      removed += stat.removed;
      continue;
    }
    if (op?.kind === 'edit') {
      const stat = diffLines(op.oldText, op.newText).stat;
      added += stat.added;
      removed += stat.removed;
      continue;
    }

    const tool = node.tool;
    const activity = presentationOf(tool).activity;
    if (activity === 'image') images += 1;
    else if (activity === 'command') commands += 1;
    else if (activity === 'skill') skillCalls += 1;
    else if (isBrowserToolName(tool) && !OBSERVATION.test(tool)) browserSteps += 1;
  }

  return { added, removed, images, browserSteps, commands, skillCalls };
}
