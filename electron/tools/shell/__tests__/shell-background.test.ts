import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputSpool } from '../../state/output-spool.js';
import { BackgroundRegistry } from '../../state/background-registry.js';
import type { ToolContext } from '../../types.js';
import { ShellTool } from '../shell.tool.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

describe('ShellTool background handoff', () => {
  let tempDir: string;
  let registry: BackgroundRegistry;

  const commandForPlatform = (commands: { bash: string; powershell: string }): string =>
    process.platform === 'win32' ? commands.powershell : commands.bash;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-shell-background-'));
    registry = new BackgroundRegistry();
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
      background: registry.forCall(callId, vi.fn(() => true)),
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
