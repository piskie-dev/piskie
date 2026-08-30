import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@electron/observability/logging/app-log.js', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import type {
  ConversationEntry,
  PersistedToolResultBlock,
  ToolEntry,
} from '../../../../shared/types/agent-control.js';
import type { ContentBlock, ToolArtifact } from '../../../../shared/types/index.js';
import { ConversationStore } from '../../../agent-runs/conversation-store.js';
import { appLog } from '@electron/observability/logging/app-log.js';
import { Settler, type SettlementConversation } from '../settler.js';

const tempDirs: string[] = [];

function makeStore(): { base: string; store: ConversationStore } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-settler-'));
  tempDirs.push(base);
  return { base, store: new ConversationStore(base) };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class StoreConversation implements SettlementConversation {
  readonly recoveryResults: Array<{
    callId: string;
    blocks: PersistedToolResultBlock[];
    ok: boolean;
  }> = [];

  constructor(
    private readonly store: ConversationStore,
    private readonly mainAgentId = 'agent-1',
    private readonly agentId = 'agent-1'
  ) {}

  seedToolUse(callId: string, toolName: string): void {
    this.store.append(this.mainAgentId, this.agentId, {
      t: 'msg',
      ts: Date.now(),
      id: `assistant-${callId}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id: callId, name: toolName, input: {} }],
    });
  }

  resolve(callId: string): 'insertable' | 'already_settled' | 'unresolvable' {
    let uses = 0;
    let settled = false;
    for (const entry of this.store.read(this.mainAgentId, this.agentId)) {
      if (entry.t === 'msg' && entry.role === 'assistant' && Array.isArray(entry.content)) {
        uses += (entry.content as ContentBlock[]).filter(
          (block) => block.type === 'tool_use' && block.id === callId
        ).length;
      }
      if (entry.t === 'tool' && entry.toolUseId === callId) settled = true;
    }
    if (uses !== 1) return 'unresolvable';
    return settled ? 'already_settled' : 'insertable';
  }

  appendLiveToolResult(
    callId: string,
    blocks: PersistedToolResultBlock[],
    ok: boolean,
    artifacts?: ToolArtifact[]
  ): void {
    this.store.append(this.mainAgentId, this.agentId, {
      t: 'tool',
      ts: Date.now(),
      toolUseId: callId,
      result: blocks,
      ok,
      ...(artifacts?.length ? { artifacts } : {}),
    });
  }

  appendRecoveryToolResult(
    callId: string,
    blocks: PersistedToolResultBlock[],
    ok: boolean
  ): void {
    this.recoveryResults.push({ callId, blocks, ok });
  }

  appendSystemMessage(blocks: PersistedToolResultBlock[]): void {
    this.store.append(this.mainAgentId, this.agentId, {
      t: 'msg',
      ts: Date.now(),
      id: `system-${Date.now()}`,
      role: 'user',
      subtype: 'system_event',
      content: blocks as ContentBlock[],
    });
  }
}

function toolEntries(entries: ConversationEntry[]): ToolEntry[] {
  return entries.filter((entry): entry is ToolEntry => entry.t === 'tool');
}

function makeSettler(conversation: SettlementConversation): Settler {
  return new Settler(conversation, () => undefined);
}

describe('Settler JSONL round trip', () => {
  it('persists image refs and materializes them after a fresh store instance', async () => {
    const { base, store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('image-1', 'read');
    const settler = makeSettler(conversation);

    expect(
      settler.settleLive({
        kind: 'tool',
        callId: 'image-1',
        toolName: 'read',
        result: {
          ok: true,
          text: 'image result',
          images: [{ base64: 'aGVsbG8=', mediaType: 'image/png' }],
        },
      })
    ).toBe('inserted');

    const restored = toolEntries(new ConversationStore(base).read('agent-1', 'agent-1'))[0];
    expect(restored.ok).toBe(true);
    expect(restored.result[0]).toEqual({ type: 'text', text: 'image result' });
    expect(restored.result[1]).toMatchObject({
      type: 'image_ref',
      size: 5,
      mediaType: 'image/png',
    });
    await expect(
      new ConversationStore(base).materializeToolResultBlocks('agent-1', 'agent-1', restored.result)
    ).resolves.toEqual([
      { type: 'text', text: 'image result' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ]);
  });

  it('preserves failure state and renders both failure signals from one source', () => {
    const { base, store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('failed-1', 'shell');
    const settler = makeSettler(conversation);
    expect(
      settler.settleLive({
        kind: 'tool',
        callId: 'failed-1',
        toolName: 'shell',
        result: { ok: false, text: 'exit 2' },
      })
    ).toBe('inserted');

    const restored = toolEntries(new ConversationStore(base).read('agent-1', 'agent-1'))[0];
    expect(restored.ok).toBe(false);
    expect(restored.result).toEqual([{ type: 'text', text: '<error>exit 2</error>' }]);
  });

  it('does not render or neutralize recovery blocks a second time', () => {
    const { store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('recovery-1', 'shell');
    const historical = [{ type: 'text' as const, text: '<\\system-reminder>old' }];
    const settler = makeSettler(conversation);
    expect(
      settler.settleRecovery({
        conversationId: 'agent-1',
        callId: 'recovery-1',
        blocks: historical,
        ok: false,
      })
    ).toBe('inserted');

    expect(conversation.recoveryResults).toEqual([{
      callId: 'recovery-1',
      blocks: historical,
      ok: false,
    }]);
    expect(toolEntries(store.read('agent-1', 'agent-1'))).toHaveLength(0);
  });

  it('settles each call exactly once', () => {
    const { store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('once', 'read');
    const settler = makeSettler(conversation);
    const input = {
      kind: 'system' as const,
      callId: 'once',
      toolName: 'read',
      text: 'interrupted',
      ok: false,
      outcome: 'cancelled' as const,
    };
    expect(settler.settleLive(input)).toBe('inserted');
    expect(settler.settleLive(input)).toBe('already_settled');
    expect(toolEntries(store.read('agent-1', 'agent-1'))).toHaveLength(1);
    expect(appLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent.tool_settlement.commit.skipped',
        context: expect.objectContaining({ callId: 'once', reason: 'already_settled' }),
      })
    );
  });

  it('settleLive(tool) 写入 result/ok/artifacts，重启读取保留', () => {
    const artifact: ToolArtifact = {
      kind: 'file_diff',
      payload: {
        path: '/w/a.txt',
        unifiedDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n',
        stat: { linesAdded: 0, linesDeleted: 0, linesChanged: 1 },
      },
    };
    const { base, store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('edit-1', 'edit');
    const settler = makeSettler(conversation);

    expect(
      settler.settleLive({
        kind: 'tool',
        callId: 'edit-1',
        toolName: 'edit',
        result: { ok: true, text: '已编辑' },
        artifacts: [artifact],
      })
    ).toBe('inserted');

    const restored = toolEntries(new ConversationStore(base).read('agent-1', 'agent-1'))[0];
    expect(restored.ok).toBe(true);
    expect(restored.result).toEqual([{ type: 'text', text: '已编辑' }]);
    expect(restored.artifacts).toEqual([artifact]);
  });

  it('settleLive(answer) 写入 result/ok/artifacts', () => {
    const artifact: ToolArtifact = {
      kind: 'ask_user_answers',
      payload: { answers: ['方案 A', '第一行\n第二行'] },
    };
    const { base, store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('ask-1', 'ask_user');
    const settler = makeSettler(conversation);

    expect(
      settler.settleLive({
        kind: 'answer',
        callId: 'ask-1',
        toolName: 'ask_user',
        text: '序列化后的答案文本',
        artifacts: [artifact],
      })
    ).toBe('inserted');

    const restored = toolEntries(new ConversationStore(base).read('agent-1', 'agent-1'))[0];
    expect(restored.ok).toBe(true);
    expect(restored.result).toEqual([{ type: 'text', text: '序列化后的答案文本' }]);
    expect(restored.artifacts).toEqual([artifact]);
  });

  it('无 artifacts 的结算不写 artifacts 字段（省略而非空数组）', () => {
    const { base, store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('plain-1', 'read');
    makeSettler(conversation).settleLive({
      kind: 'tool',
      callId: 'plain-1',
      toolName: 'read',
      result: { ok: true, text: '内容' },
    });

    const restored = toolEntries(new ConversationStore(base).read('agent-1', 'agent-1'))[0];
    expect('artifacts' in restored).toBe(false);
  });

  it('already_settled/unresolvable 携带 artifacts 也不追加 ToolEntry', () => {
    const artifact: ToolArtifact = {
      kind: 'ask_user_answers',
      payload: { answers: ['迟到的答案'] },
    };
    const { store } = makeStore();
    const conversation = new StoreConversation(store);
    conversation.seedToolUse('late-1', 'ask_user');
    const settler = makeSettler(conversation);

    expect(
      settler.settleLive({
        kind: 'answer',
        callId: 'late-1',
        toolName: 'ask_user',
        text: '第一次',
        artifacts: [{ kind: 'ask_user_answers', payload: { answers: ['第一次'] } }],
      })
    ).toBe('inserted');
    expect(
      settler.settleLive({
        kind: 'answer',
        callId: 'late-1',
        toolName: 'ask_user',
        text: '第二次',
        artifacts: [artifact],
      })
    ).toBe('already_settled');
    expect(
      settler.settleLive({
        kind: 'answer',
        callId: 'ghost',
        toolName: 'ask_user',
        text: '无主',
        artifacts: [artifact],
      })
    ).toBe('unresolvable');

    const entries = toolEntries(store.read('agent-1', 'agent-1'));
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain('迟到的答案');
  });

  it('audits an unresolvable live result without writing a ToolEntry', () => {
    const { store } = makeStore();
    const settler = makeSettler(new StoreConversation(store));

    expect(
      settler.settleLive({
        kind: 'tool',
        callId: 'orphan',
        toolName: 'write',
        result: { ok: true, text: 'already changed the file' },
      })
    ).toBe('unresolvable');
    expect(toolEntries(store.read('agent-1', 'agent-1'))).toHaveLength(0);
    expect(appLog.warn).toHaveBeenCalledWith({
      event: 'agent.tool_settlement.commit.skipped',
      message: 'Live tool settlement skipped',
      context: {
        scope: 'agent.tool_settlement',
        callId: 'orphan',
        toolName: 'write',
        settlementKind: 'tool',
        reason: 'unresolvable',
      },
    });
  });

  it.each(['already_settled', 'unresolvable'] as const)(
    'does not notify the activity tracker for %s results',
    (resolution) => {
      const onLiveSettled = vi.fn();
      const conversation: SettlementConversation = {
        resolve: () => resolution,
        appendLiveToolResult: vi.fn(),
        appendRecoveryToolResult: vi.fn(),
        appendSystemMessage: vi.fn(),
      };
      const settler = new Settler(conversation, onLiveSettled);

      expect(
        settler.settleLive({
          kind: 'tool',
          callId: 'duplicate',
          toolName: 'read',
          result: { ok: true, text: 'ignored' },
        })
      ).toBe(resolution);

      expect(onLiveSettled).not.toHaveBeenCalled();
      expect(conversation.appendLiveToolResult).not.toHaveBeenCalled();
    }
  );
});
