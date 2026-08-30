/**
 * 分派前先定状态：专属呈现（计划卡 / 子流程行）与抑制名单都建立在
 * `resolveToolOutcome()` 之上，降级态一律回落通用工具行。
 *
 * 回归来源：用户 2026-08-07 反馈"为什么显示了两个创建子流程"。真相是首次
 * `subagent` 被"当前 Main 尚未建立 Task Board"拒绝、补救用的 `task` 又整条落在
 * 抑制名单里，于是一条"失败→补救→重试"的因果链在屏幕上只剩两条一模一样的灰字。
 *
 * 钉四条：
 * 1. 失败的 `subagent(create)` 不走 WorkerNode，回落通用行并染 danger
 * 2. 失败的 `task` 不被抑制（成功的仍抑制）
 * 3. 失败的 `plan(create)` 不走 PlanNode
 * 4. 待审批的 `plan(create)` 仍是 PlanNode —— awaiting-approval 不是降级态
 */

import { describe, expect, it } from 'vitest';

import type {
  ConversationEntry,
  PersistedToolResultBlock,
} from '../../../../../../shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { TranscriptNode } from '@/domains/transcript/nodes';

function callAndResult(
  tool: string,
  input: Record<string, unknown>,
  resultText: string,
  ok: boolean,
): ConversationEntry[] {
  return [
    {
      t: 'msg',
      ts: 1,
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: tool, input }],
    },
    {
      t: 'tool',
      ts: 2,
      toolUseId: 'call-1',
      ok,
      result: [{ type: 'text', text: resultText }] as PersistedToolResultBlock[],
    },
  ];
}

/** 只看工具产生的那条 cell（turn/notice 等不参与本用例） */
function toolCells(entries: readonly ConversationEntry[]): TranscriptNode[] {
  return projectConversationNodes(entries).filter((node) => node.id === 'call-1');
}

/** 断言恰好一条并取出（下标访问在 noUncheckedIndexedAccess 下是 `TranscriptNode | undefined`） */
function soleToolCell(entries: readonly ConversationEntry[]): TranscriptNode {
  const cells = toolCells(entries);
  expect(cells).toHaveLength(1);
  const [cell] = cells;
  if (!cell) throw new Error('unreachable: length asserted above');
  return cell;
}

const SUBAGENT_INPUT = { action: 'create', type: 'local', subject: '实现山川平原河流地形' };

describe('降级态回落通用工具行', () => {
  it('subagent 创建失败 → tool cell + danger，而非子流程行', () => {
    const cell = soleToolCell(
      callAndResult('subagent', SUBAGENT_INPUT, '<error>当前 Main 尚未建立 Task Board</error>', false),
    );

    expect(cell.kind).toBe('tool');
    expect(cell.tone).toBe('danger');
    expect(cell.summary).toEqual({
      kind: 'raw',
      text: '当前 Main 尚未建立 Task Board',
    });
  });

  it('subagent 创建成功 → 仍是子流程行', () => {
    const cell = soleToolCell(
      callAndResult('subagent', SUBAGENT_INPUT, '本地模式子流程已创建: 实现山川平原河流地形', true),
    );

    expect(cell.kind).toBe('worker');
  });

  it('task 失败不被抑制，成功仍被抑制', () => {
    const failed = soleToolCell(
      callAndResult('task', { items: [] }, '<error>Task Board 在读取后已发生变化</error>', false),
    );
    expect(failed.kind).toBe('tool');
    expect(failed.tone).toBe('danger');

    const ok = toolCells(callAndResult('task', { items: [] }, 'Task Board 已同步：0/1 completed', true));
    expect(ok).toHaveLength(0);
  });

  it('plan 提交失败 → tool cell；待审批 → 仍是计划卡', () => {
    const planInput = { action: 'create', taskSummary: '重构地图', planDocument: '## 背景' };

    const failed = soleToolCell(
      callAndResult('plan', planInput, '<error>参数不符合 schema</error>', false),
    );
    expect(failed.kind).toBe('tool');
    expect(failed.tone).toBe('danger');

    // 待审批：只有 tool_use、无结果条目，且 pendingCallId 命中
    const pendingEntries: ConversationEntry[] = [
      {
        t: 'msg',
        ts: 1,
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'plan', input: planInput }],
      } as ConversationEntry,
    ];
    const pending = projectConversationNodes(pendingEntries, { pendingCallId: 'call-1' }).filter(
      (cell) => cell.id === 'call-1',
    );
    expect(pending).toHaveLength(1);
    const [planCell] = pending;
    expect(planCell?.kind).toBe('plan');
    expect(planCell?.tone).toBe('warning');
  });
});
