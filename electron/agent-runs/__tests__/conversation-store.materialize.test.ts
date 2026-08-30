/**
 * 图片外部化/还原对偶：
 * externalize（append 写入侧）→ image_ref → materialize（replay 读取侧）base64 保真；
 * 缺失 blob / 路径越界降级为文本占位，不中断 replay。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';



import { ConversationStore } from '../conversation-store.js';
import type { ConversationWriteEntry, ToolEntry } from '../../../shared/types/agent-control.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-store-test-'));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const MAIN = 'main-t';
const AGENT = 'worker-t';

function makeStore(): ConversationStore {
  return new ConversationStore(fs.mkdtempSync(path.join(tmpRoot, 'store-')));
}

describe('materializeToolResultBlocks', () => {
  it('text 原样通过', async () => {
    const store = makeStore();
    const out = await store.materializeToolResultBlocks(MAIN, AGENT, [
      { type: 'text', text: '普通文本' },
    ]);
    expect(out).toEqual([{ type: 'text', text: '普通文本' }]);
  });

  it('image_ref：异步读取 blob 转 base64（payload 多模态保真）', async () => {
    const store = makeStore();
    const blobsDir = store.getBlobsDir(MAIN, AGENT);
    fs.mkdirSync(blobsDir, { recursive: true });
    const raw = Buffer.from('fake-png-bytes');
    fs.writeFileSync(path.join(blobsDir, 'pic.png'), raw);

    const out = await store.materializeToolResultBlocks(MAIN, AGENT, [
      { type: 'image_ref', path: 'blobs/pic.png', size: raw.length, mediaType: 'image/png' },
    ]);
    expect(out).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: raw.toString('base64') } },
    ]);
  });

  it('缺失 blob：降级文本占位，不抛（replay 不中断）', async () => {
    const store = makeStore();
    const out = await store.materializeToolResultBlocks(MAIN, AGENT, [
      { type: 'image_ref', path: 'blobs/missing.png', size: 1, mediaType: 'image/png' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('text');
    expect((out[0] as { text: string }).text).toContain('图片不可用');
    expect((out[0] as { text: string }).text).toContain('blobs/missing.png');
  });

  it('路径越界（../ 逃逸 blobs 目录）：拒绝读取，降级文本占位', async () => {
    const store = makeStore();
    const out = await store.materializeToolResultBlocks(MAIN, AGENT, [
      { type: 'image_ref', path: '../../../etc/passwd', size: 1, mediaType: 'image/png' },
    ]);
    expect(out[0].type).toBe('text');
    expect((out[0] as { text: string }).text).toContain('越界');
  });
});

describe('externalize → 重启读取 → materialize 往返（写读对偶）', () => {
  it('1 字节图片 append 后也落为 image_ref，materialize 还原出等值 base64', async () => {
    const store = makeStore();
    const imageData = Buffer.from([7]).toString('base64');
    const entry: ConversationWriteEntry = {
      t: 'tool',
      ts: 1,
      toolUseId: 'ask-1',
      result: [
        { type: 'text', text: '答案文本' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
      ],
      ok: true,
    };
    store.append(MAIN, AGENT, entry);

    const persisted = store.read(MAIN, AGENT);
    expect(persisted).toHaveLength(1);
    const toolEntry = persisted[0] as ToolEntry;
    expect(toolEntry.result[0]).toEqual({ type: 'text', text: '答案文本' });
    expect(toolEntry.result[1].type).toBe('image_ref');   // 磁盘上是引用，不是内联大图

    const restored = await store.materializeToolResultBlocks(MAIN, AGENT, toolEntry.result);
    expect(restored[0]).toEqual({ type: 'text', text: '答案文本' });
    expect(restored[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageData },
    });
  });

  it('接受 MCP schema 允许的带空白 Base64，并以规范形式恢复', async () => {
    const store = makeStore();
    store.append(MAIN, AGENT, {
      t: 'tool',
      ts: 1,
      toolUseId: 'mcp-whitespace-image',
      result: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVs\nbG8=' },
      }],
      ok: true,
    });

    const [entry] = store.read(MAIN, AGENT);
    if (entry?.t !== 'tool') throw new Error('tool result missing');
    await expect(store.materializeToolResultBlocks(MAIN, AGENT, entry.result)).resolves.toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      },
    ]);
  });

  it('相同图片只写一个 Blob，所有引用保持相同路径', () => {
    const store = makeStore();
    const data = Buffer.from('same-image').toString('base64');
    store.append(MAIN, AGENT, {
      t: 'msg',
      ts: 1,
      id: 'dedupe',
      role: 'user',
      subtype: 'user_input',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    });

    const [entry] = store.read(MAIN, AGENT);
    if (entry?.t !== 'msg' || !Array.isArray(entry.content)) throw new Error('message missing');
    const paths = entry.content
      .filter((block) => block.type === 'image_ref')
      .map((block) => block.path);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(1);
    expect(fs.readdirSync(store.getBlobsDir(MAIN, AGENT))).toHaveLength(1);
  });

  it('三张引用与文本按原始 block 顺序完整物化', async () => {
    const store = makeStore();
    const blobsDir = store.getBlobsDir(MAIN, AGENT);
    fs.mkdirSync(blobsDir, { recursive: true });
    const refs = ['one', 'two', 'three'].map((value) => {
      const file = `${value}.png`;
      const bytes = Buffer.from(value);
      fs.writeFileSync(path.join(blobsDir, file), bytes);
      return {
        type: 'image_ref' as const,
        path: `blobs/${file}`,
        size: bytes.length,
        mediaType: 'image/png',
      };
    });

    await expect(store.materializeMessageContent(MAIN, AGENT, [
      refs[0],
      { type: 'text', text: 'between' },
      refs[1],
      refs[2],
    ])).resolves.toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('one').toString('base64') } },
      { type: 'text', text: 'between' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('two').toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('three').toString('base64') } },
    ]);
  });
});

describe('scanHeaders AgentRun ownership', () => {
  it('scans only top-level Main directories and does not treat Workers as AgentRuns', () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'scan-'));
    const store = new ConversationStore(root);
    const realHeader = {
      agentId: 'main-real',
      agentSpec: 'director',
      modeId: 'normal',
      runConfig: { name: 'real', description: 'real', promptTemplate: 'real' },
      createdAt: '',
      lastActiveAt: '',
      currentModel: 'provider::model',
      approvalMode: 'confirm',
      childAgents: [],
    } as const;
    store.writeHeader('main-real', realHeader as never);

    const fakeHeaderDir = store.getOwnerDir('main-real', 'fake-worker');
    fs.mkdirSync(fakeHeaderDir, { recursive: true });
    fs.writeFileSync(path.join(fakeHeaderDir, 'header.json'), JSON.stringify({
      ...realHeader,
      agentId: 'fake-worker',
    }));

    expect(store.scanHeaders().map((header) => header.agentId)).toEqual(['main-real']);
  });
});
