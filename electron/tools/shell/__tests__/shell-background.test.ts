import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputSpool } from '../../state/output-spool.js';
import { BackgroundRegistry } from '../../state/background-registry.js';
import type { AgentInputRequest } from '../../../../shared/types/index.js';
import { renderNotification, type BackgroundDoneEvent } from '../../../agent/conversation/model-text.js';
import type { ToolContext } from '../../types.js';
import { ShellTool } from '../shell.tool.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

describe('ShellTool background handoff', () => {
  let tempDir: string;
  let registry: BackgroundRegistry;
  let notifications: AgentInputRequest[];

  const commandForPlatform = (commands: { bash: string; powershell: string }): string =>
    process.platform === 'win32' ? commands.powershell : commands.bash;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-shell-background-'));
    registry = new BackgroundRegistry();
    notifications = [];
  });

  afterEach(async () => {
    await registry.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function context(callId: string, signal = new AbortController().signal): ToolContext {
    return {
      agentId: 'agent-1',
      callId,
      workspace: { dir: tempDir, tempDir },
      signal,
      spool: new OutputSpool({ tempDir }),
      declareTerminal: vi.fn(),
      post: vi.fn(() => true),
      background: registry.forCall(callId, (event) => { notifications.push(event); return true; }),
      log: vi.fn(),
      agentType: 'worker',
      agentSpec: 'local-worker',
      mainAgentId: 'main-1',
      runConfig: { name: 'test', description: '', promptTemplate: '' },
      resourceIds: {},
      currentModel: 'provider::model',
      modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
    };
  }

  it('withdraws the offer and returns the foreground result when the process exits first', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({
      command: commandForPlatform({
        bash: "printf 'hello'",
        powershell: "[Console]::Write('hello')",
      }),
      timeout: 60_000,
      run_in_background: false,
    }, context('foreground'));

    expect(result).toMatchObject({ ok: true, text: 'hello' });
    expect(registry.promote('foreground')).toBe(false);
    expect(registry.hasActiveJobs()).toBe(false);
  });

  it('passes the shared host environment to shell commands', async () => {
    const previous = process.env.PISKIE_SHELL_ENV_TEST;
    process.env.PISKIE_SHELL_ENV_TEST = 'available';
    try {
      const result = await new ShellTool().execute({
        command: commandForPlatform({
          bash: `printf '%s' "$PISKIE_SHELL_ENV_TEST"`,
          powershell: '[Console]::Write($env:PISKIE_SHELL_ENV_TEST)',
        }),
        timeout: 60_000,
        run_in_background: false,
      }, context('environment'));

      expect(result).toMatchObject({ ok: true, text: 'available' });
    } finally {
      if (previous === undefined) delete process.env.PISKIE_SHELL_ENV_TEST;
      else process.env.PISKIE_SHELL_ENV_TEST = previous;
    }
  });

  it.each(['declared', 'timeout', 'user'] as const)('preserves the description and complete output after %s handoff', async (reason) => {
    const delayMs = reason === 'timeout' ? 1_500 : 200;
    const callId = `sample-${reason}`;
    const execution = new ShellTool().execute({
      command: commandForPlatform({
        bash: `sleep ${delayMs / 1_000}\nprintf 'First line\\nSecond line\\n'`,
        powershell: `Start-Sleep -Milliseconds ${delayMs}\n[Console]::Write("First line\`nSecond line\`n")`,
      }),
      description: 'Sample multiline check',
      timeout: reason === 'timeout' ? 1_000 : 60_000,
      run_in_background: reason === 'declared',
    }, context(callId));
    if (reason === 'user') {
      await vi.waitFor(() => expect(registry.promote(callId)).toBe(true));
    }
    const result = await execution;
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 5_000 });
    const event = notifications[0]!.content as BackgroundDoneEvent;
    expect(result.data).toEqual(expect.objectContaining({ taskId: event.taskId }));
    expect(event).toMatchObject({
      kind: 'background_task_done', status: 'ok', outputTruncated: false,
      summary: expect.stringContaining('Sample multiline check'), tail: 'First line\nSecond line\n',
    });
    const message = renderNotification(event);
    expect(message).toContain(`<task-id>${event.taskId}</task-id>`);
    expect(message).toContain('完整输出：\nFirst line\nSecond line\n');
    expect(message).not.toContain('<output-file>');
  });

  it('reports a silent command without a description by task id and without a log link', async () => {
    const result = await new ShellTool().execute({
      command: 'exit 0', timeout: 60_000, run_in_background: true,
    }, context('sample-silent'));
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    const event = notifications[0]!.content as BackgroundDoneEvent;
    expect(result.data).toEqual(expect.objectContaining({ taskId: event.taskId }));
    expect(event).toMatchObject({ status: 'ok', tail: '', outputTruncated: false });
    const message = renderNotification(event);
    expect(message).toContain('无输出。');
    expect(message).not.toContain('<output-file>');
  });

  it('reports truncated output with a readable complete log', async () => {
    const tail = 'x'.repeat(16_384);
    const fullOutput = 'Earlier sample output.\n' + tail;
    await fs.writeFile(path.join(tempDir, 'sample-output.txt'), fullOutput, 'utf8');
    const result = await new ShellTool().execute({
      command: commandForPlatform({
        bash: 'cat sample-output.txt',
        powershell: "[Console]::Write([IO.File]::ReadAllText('sample-output.txt'))",
      }),
      description: 'Sample verbose check', timeout: 60_000, run_in_background: true,
    }, context('sample-verbose'));
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    const event = notifications[0]!.content as BackgroundDoneEvent;
    expect(event).toMatchObject({ outputTruncated: true, tail });
    if (!event.outputTruncated) throw new Error('Expected truncated sample output');
    await expect(fs.readFile(event.outputFile, 'utf8')).resolves.toBe(fullOutput);
    const message = renderNotification(event);
    expect(message).toContain('输出已截断，仅显示最后 16 KB：');
    expect(message).toContain(`<output-file>${event.outputFile}</output-file>`);
  });

  it('returns immediately through adopt when the user promotes the live call', async () => {
    const tool = new ShellTool();
    const execution = tool.execute({
      command: commandForPlatform({
        bash: 'sleep 30',
        powershell: 'Start-Sleep -Seconds 30',
      }),
      timeout: 600_000,
      run_in_background: false,
    }, context('promoted'));

    await vi.waitFor(() => expect(registry.promote('promoted')).toBe(true));
    const result = await execution;

    expect(result.ok).toBe(true);
    expect(result.text).toContain('已转入后台（用户要求）');
    expect(result.data).toEqual(expect.objectContaining({
      taskId: expect.any(String),
      outFile: expect.stringContaining(`${path.sep}bg${path.sep}`),
    }));
    expect(registry.hasActiveJobs()).toBe(true);
  });
});
