/**
 * artifacts 的持久化与读取：ConversationStore 对 artifacts 是
 * 纯透传（不理解语义、不参与 externalize/materialize），append/read/readFrom/
 * 监听器/重启读取全链路保真；replay 读取侧（materializeToolResultBlocks）只
 * 消费 result，模型消息与 artifacts 无关。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';



import { ConversationStore, type ConversationAppendRecord } from '../conversation-store.js';
import type {
  ConversationEntry,
  ConversationWriteEntry,
  ToolEntry,
} from '../../../shared/types/agent-control.js';
import type { ToolArtifact } from '../../../shared/types/index.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-store-artifacts-'));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const FLOW = 'flow-a';
const AGENT = 'agent-a';

const DIFF_ARTIFACT: ToolArtifact = {
  kind: 'file_diff',
  payload: {
    path: '/w/a.txt',
    unifiedDiff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-旧\n+新\n',
    stat: { linesAdded: 0, linesDeleted: 0, linesChanged: 1 },
  },
};

const ANSWERS_ARTIFACT: ToolArtifact = {
  kind: 'ask_user_answers',
  payload: { answers: ['方案 A', '多行\n答案'] },
};

function makeBase(): string {
  return fs.mkdtempSync(path.join(tmpRoot, 'store-'));
}

function toolEntry(
  callId: string,
  artifacts?: ToolArtifact[],
): Extract<ConversationWriteEntry, { t: 'tool' }> {
  return {
    t: 'tool',
    ts: Date.now(),
    toolUseId: callId,
    result: [{ type: 'text', text: `result-${callId}` }],
    ok: true,
    ...(artifacts ? { artifacts } : {}),
  };
}

function toolEntries(entries: ConversationEntry[]): ToolEntry[] {
  return entries.filter((entry): entry is ToolEntry => entry.t === 'tool');
}

describe('replay 与存储', () => {
  it('1. append/read/readFrom round-trip 保留 artifacts', () => {
    const store = new ConversationStore(makeBase());
    store.append(FLOW, AGENT, toolEntry('c-1', [DIFF_ARTIFACT]));
    store.append(FLOW, AGENT, toolEntry('c-2', [ANSWERS_ARTIFACT]));

    const read = toolEntries(store.read(FLOW, AGENT));
    expect(read[0].artifacts).toEqual([DIFF_ARTIFACT]);
    expect(read[1].artifacts).toEqual([ANSWERS_ARTIFACT]);

    const fromSecond = toolEntries(store.readFrom(FLOW, AGENT, 1));
    expect(fromSecond).toHaveLength(1);
    expect(fromSecond[0].artifacts).toEqual([ANSWERS_ARTIFACT]);
  });

  it('2. append 监听器收到的 entry 与盘上 entry 相同', () => {
    const store = new ConversationStore(makeBase());
    const seen: ConversationEntry[] = [];
    store.subscribeAppends(({ entry }) => {
      seen.push(entry);
    });

    store.append(FLOW, AGENT, toolEntry('c-1', [DIFF_ARTIFACT]));

    const onDisk = store.read(FLOW, AGENT);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(onDisk[0]);
    expect((seen[0] as ToolEntry).artifacts).toEqual([DIFF_ARTIFACT]);
  });

  it('append metadata is observable after the write but never serialized', () => {
    const store = new ConversationStore(makeBase());
    const seen: ConversationAppendRecord[] = [];
    store.subscribeAppends((record) => seen.push(record));
    store.append(FLOW, AGENT, {
      t: 'msg',
      ts: 1,
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    }, { requestId: 'request-1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe('request-1');
    expect(seen[0]?.entry).not.toHaveProperty('requestId');
    expect(store.read(FLOW, AGENT)[0]).not.toHaveProperty('requestId');
  });

  it('3. 重启（新 store 实例）后读取自己产生的记录仍保留 artifacts', () => {
    const base = makeBase();
    new ConversationStore(base).append(FLOW, AGENT, toolEntry('c-1', [ANSWERS_ARTIFACT]));

    const restored = toolEntries(new ConversationStore(base).read(FLOW, AGENT));
    expect(restored[0].artifacts).toEqual([ANSWERS_ARTIFACT]);
    expect(restored[0].result).toEqual([{ type: 'text', text: 'result-c-1' }]);
  });

  it('4. replay 读取侧只消费 result：有无 artifacts 的模型内容块完全相同', async () => {
    const store = new ConversationStore(makeBase());
    const withArtifacts = toolEntry('c-1', [DIFF_ARTIFACT, ANSWERS_ARTIFACT]);
    const without = toolEntry('c-1');

    expect(await store.materializeToolResultBlocks(FLOW, AGENT, withArtifacts.result))
      .toEqual(await store.materializeToolResultBlocks(FLOW, AGENT, without.result));
  });

  it('5. summary 条目前后的 artifact 都可被读取（summary 不吞 JSONL 记录）', () => {
    const store = new ConversationStore(makeBase());
    store.append(FLOW, AGENT, toolEntry('before-summary', [DIFF_ARTIFACT]));
    store.append(FLOW, AGENT, {
      t: 'summary',
      ts: Date.now(),
      summary: { text: '压缩摘要' } as never,
    });
    store.append(FLOW, AGENT, toolEntry('after-summary', [ANSWERS_ARTIFACT]));

    const read = toolEntries(store.read(FLOW, AGENT));
    expect(read.map(entry => entry.artifacts)).toEqual([
      [DIFF_ARTIFACT],
      [ANSWERS_ARTIFACT],
    ]);
  });

  it('6. image externalize/absolutize 不改 artifacts', () => {
    const base = makeBase();
    const store = new ConversationStore(base);
    // result 带大图触发 externalize（写入侧会把 base64 externalize 成 image_ref）
    const big = Buffer.alloc(64 * 1024, 7).toString('base64');
    const entry: Extract<ConversationWriteEntry, { t: 'tool' }> = {
      t: 'tool',
      ts: Date.now(),
      toolUseId: 'img-1',
      result: [
        { type: 'text', text: '带图结果' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
      ],
      ok: true,
      artifacts: [DIFF_ARTIFACT],
    };
    store.append(FLOW, AGENT, entry);

    const persisted = toolEntries(store.read(FLOW, AGENT))[0];
    expect(persisted.artifacts).toEqual([DIFF_ARTIFACT]);

    const absolutized = store.absolutizeImageRefs(FLOW, AGENT, persisted) as ToolEntry;
    expect(absolutized.artifacts).toEqual([DIFF_ARTIFACT]);
  });

  it('7. MCP 音频 artifact 与其他 UI 事实一样由存储层原样透传', () => {
    const base = makeBase();
    const store = new ConversationStore(base);
    store.append(FLOW, AGENT, toolEntry('mcp-1', [
      {
        kind: 'mcp_audio',
        payload: { mimeType: 'audio/wav', dataBase64: 'c291bmQ=' },
      },
    ]));

    const [persisted] = toolEntries(store.read(FLOW, AGENT));
    expect(persisted.artifacts).toEqual([{
      kind: 'mcp_audio',
      payload: { mimeType: 'audio/wav', dataBase64: 'c291bmQ=' },
    }]);

    const projected = store.absolutizeImageRefs(FLOW, AGENT, persisted) as ToolEntry;
    expect(projected.artifacts).toEqual(persisted.artifacts);
  });

});
