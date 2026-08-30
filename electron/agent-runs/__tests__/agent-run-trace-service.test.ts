import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/piskie-agent-run-trace-test';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-agent-run-trace-test' },
}));

import { AgentRunTraceService } from '../agent-run-trace-service.js';

let traces: AgentRunTraceService;

beforeEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  traces = new AgentRunTraceService(ROOT);
});

describe('AgentRunTraceService', () => {
  it('writes a headerless Main trace, redacts secrets, and remains listable after detach', async () => {
    const observer = await traces.attach('main-1');
    observer.contentProduced({
      type: 'tool_start',
      toolName: 'agent_run',
      params: { action: 'create', password: 'secret-value' },
    });
    observer.contentProduced({
      type: 'tool_finish',
      ok: true,
      toolName: 'request',
      result: '{"authorization":"result secret", "cookie":"part one; part two"}',
    });
    traces.recordLifecycle('main-1', 'stopped');
    await traces.detach('main-1');

    const tracePath = traces.tracePath('main-1');
    const content = await fs.readFile(tracePath, 'utf-8');
    expect(tracePath).toBe(path.join(ROOT, 'agent-runs', 'main-1', 'trace.md'));
    expect(content).not.toContain('[flow]');
    expect(content).toContain('agent_run(');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('secret-value');
    expect(content).not.toContain('result secret');
    expect(content).not.toContain('part one');
    expect(content).not.toContain('part two');

    await expect(traces.list()).resolves.toEqual([
      expect.objectContaining({
        agentId: 'main-1',
        recentTail: expect.stringContaining('通知 stopped'),
        tracePath,
      }),
    ]);
  });

  it('reattach appends and rejects late output from the detached observer', async () => {
    const oldObserver = await traces.attach('main-1');
    oldObserver.contentProduced({ type: 'assistant_text', content: '恢复前进度' });
    await traces.detach('main-1');
    const newObserver = await traces.attach('main-1');
    oldObserver.contentProduced({ type: 'assistant_text', content: '迟到旧世代' });
    newObserver.contentProduced({ type: 'assistant_text', content: '恢复后继续' });
    await traces.detach('main-1');

    const content = await fs.readFile(traces.tracePath('main-1'), 'utf-8');
    expect(content).toContain('恢复前进度');
    expect(content).toContain('恢复后继续');
    expect(content).not.toContain('迟到旧世代');
  });

  it('lists a valid UTF-8 tail after rolling a large trace', async () => {
    const observer = await traces.attach('main-roll');
    for (let index = 0; index < 900; index += 1) {
      observer.contentProduced({
        type: 'tool_finish',
        ok: true,
        toolName: 'step',
        result: index === 899
          ? `最新动态-${index}-${'进'.repeat(280)}`
          : `event-${index}-${'x'.repeat(280)}`,
      });
    }
    await traces.detach('main-roll');

    const tracePath = traces.tracePath('main-roll');
    const content = await fs.readFile(tracePath, 'utf-8');
    expect(content.startsWith('（前文已滚动截断）\n')).toBe(true);
    await expect(traces.list()).resolves.toEqual([
      expect.objectContaining({
        agentId: 'main-roll',
        recentTail: expect.stringContaining('最新动态-899-'),
        tracePath,
      }),
    ]);
    const [listed] = await traces.list();
    expect(listed!.recentTail).not.toContain('�');
  });
});
