import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeTraceWriter } from '../runtime-trace-writer.js';

const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-trace-writer-test-'));

describe('RuntimeTraceWriter', () => {
  let writer: RuntimeTraceWriter;

  beforeEach(() => {
    writer = new RuntimeTraceWriter((runtimeId) => (
      path.join(TEST_ROOT, 'agent-runs', 'main-1', 'workers', runtimeId, 'trace.md')
    ));
  });

  it('persists tool events and lifecycle notifications', async () => {
    writer.recordContentEvent('worker-1', {
      type: 'tool_start',
      toolName: 'browser_navigateTo',
      params: { url: 'https://example.com' },
    });
    writer.recordContentEvent('worker-1', {
      type: 'tool_finish',
      ok: true,
      toolName: 'browser_navigateTo',
      result: '导航成功',
    });
    writer.recordContentEvent('worker-1', {
      type: 'tool_finish',
      ok: false,
      toolName: 'browser_clickByUid',
      result: 'UID 已失效',
    });
    writer.recordLifecycle('worker-1', 'completed', '任务完成');
    await writer.flush();

    const content = await fs.readFile(writer.filePathFor('worker-1'), 'utf-8');
    expect(content).toContain('→ browser_navigateTo({"url":"https://example.com"})');
    expect(content).toContain('✓ browser_navigateTo: 导航成功');
    expect(content).toContain('✗ browser_clickByUid: UID 已失效');
    expect(content).toContain('● 通知 completed: 任务完成');
    expect(content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] → /m);
  });

  it('records one completed assistant event and ignores turn boundaries', async () => {
    writer.recordContentEvent('worker-text', { type: 'assistant_text', content: '完整正文' });
    writer.recordContentEvent('worker-text', { type: 'turn_end' });
    await writer.flush();

    const content = await fs.readFile(writer.filePathFor('worker-text'), 'utf-8');
    expect(content.match(/● 完整正文/g)).toHaveLength(1);
  });

  it('uses the Worker owner trace path supplied by AgentRunPaths', () => {
    expect(writer.filePathFor('worker-1')).toBe(
      path.join(TEST_ROOT, 'agent-runs', 'main-1', 'workers', 'worker-1', 'trace.md'),
    );
  });

  it('summarizes long params and results on one line', async () => {
    writer.recordContentEvent('worker-2', {
      type: 'tool_finish',
      ok: true,
      toolName: 't',
      result: `多行\n结果 ${'x'.repeat(500)}`,
    });
    await writer.flush();

    const content = await fs.readFile(writer.filePathFor('worker-2'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('多行 结果');
    expect(lines[0]).toContain('…');
    expect(lines[0].length).toBeLessThan(400);
  });

  it('rolls an oversized trace while retaining the newest entries', async () => {
    const large = 'y'.repeat(290);
    for (let index = 0; index < 1000; index += 1) {
      writer.recordLifecycle('worker-3', 'need_user_action', `${index}-${large}`);
    }
    await writer.flush();

    const content = await fs.readFile(writer.filePathFor('worker-3'), 'utf-8');
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(256 * 1024 + 1024);
    expect(content).toContain('（前文已滚动截断）');
    expect(content).toContain('999-');
  });
});
