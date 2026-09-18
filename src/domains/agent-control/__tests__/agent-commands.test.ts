import { describe, expect, it, vi } from 'vitest';

import type { AgentClient } from '@shared/electron-contracts/agents';
import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import type { AgentRunRepository } from '../../agent-runs/agent-run-repository';
import { createAgentCommands } from '../agent-commands';
import { createAgentControlStore } from '../agent-control-store';

function agent(agentId: string, phase: AgentControlSnapshot['phase']): AgentControlSnapshot {
  return {
    agentId,
    phase,
    children: [],
    runConfig: { name: agentId },
  } as unknown as AgentControlSnapshot;
}

function harness() {
  const interrupt = vi.fn<(agentId: string) => Promise<void>>(async () => undefined);
  const setModel = vi.fn<(agentId: string, model: string) => Promise<void>>(
    async () => undefined,
  );
  const start = vi.fn(async () => agent('started', 'waiting'));
  const agents = {
    start,
    interrupt,
    setModel,
  } as unknown as AgentClient;
  const runs = {
    clearPreview: vi.fn(),
    applyModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as unknown as AgentRunRepository;
  const control = createAgentControlStore();
  const commands = createAgentCommands(agents, control, runs);
  return { agents, commands, control, interrupt, runs, setModel, start };
}

describe('AgentCommands', () => {
  it('interrupts every busy tree and returns this operation result only', async () => {
    const test = harness();
    test.control.replace({
      first: agent('first', 'thinking'),
      second: agent('second', 'executing'),
    });
    test.interrupt.mockImplementation(async (agentId: string) => {
      if (agentId === 'second') throw new Error('failed');
    });

    await expect(test.commands.interruptAll()).resolves.toBe(false);
    expect(test.interrupt).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent command failures isolated in their returned results', async () => {
    const test = harness();
    test.setModel.mockImplementation(async (agentId: string) => {
      if (agentId === 'broken') throw new Error('model unavailable');
    });

    const [successful, failed] = await Promise.all([
      test.commands.setModel('healthy', 'provider/model'),
      test.commands.setModel('broken', 'provider/model'),
    ]);

    expect(successful).toEqual({ ok: true, value: undefined });
    expect(failed).toEqual({ ok: false, error: 'model unavailable' });
    expect(test.runs.applyModel).toHaveBeenCalledExactlyOnceWith('healthy', 'provider/model');
  });

  it('sends independently of both model saving and the confirmed preview refresh', async () => {
    const test = harness();
    let saved!: () => void;
    let refreshed!: () => void;
    test.setModel.mockReturnValue(new Promise<void>((resolve) => { saved = resolve; }));
    vi.mocked(test.runs.applyModel).mockReturnValue(new Promise<void>((resolve) => { refreshed = resolve; }));
    test.agents.inject = vi.fn().mockResolvedValue(undefined);
    const saving = test.commands.setModel('sample-run', 'sample::chosen-model');
    expect(test.runs.applyModel).not.toHaveBeenCalled();

    await expect(test.commands.inject('sample-run', {
      id: 'sample-event', source: 'user', timestamp: new Date(0), content: 'Continue the sample task.',
    })).resolves.toMatchObject({ ok: true });
    expect(test.runs.applyModel).not.toHaveBeenCalled();
    saved();
    await Promise.resolve();
    expect(test.runs.applyModel).toHaveBeenCalledExactlyOnceWith('sample-run', 'sample::chosen-model');
    await expect(test.commands.inject('sample-run', {
      id: 'sample-next-event', source: 'user', timestamp: new Date(0), content: 'Another sample message.',
    })).resolves.toMatchObject({ ok: true });
    refreshed();
    await expect(saving).resolves.toMatchObject({ ok: true });
  });

  it('returns confirmed preview read failures for the composer to display', async () => {
    const test = harness();
    vi.mocked(test.runs.applyModel).mockRejectedValueOnce(new Error('Sample preview read failed'));
    await expect(test.commands.setModel('sample-run', 'sample::chosen-model')).resolves.toEqual({
      ok: false, error: 'Sample preview read failed',
    });
    expect(test.setModel).toHaveBeenCalledExactlyOnceWith('sample-run', 'sample::chosen-model');
  });

  it('publishes the start result to control and invalidates persisted runs', async () => {
    const test = harness();

    const result = await test.commands.start({ modeId: 'normal', input: 'hello' });

    expect(result).toEqual({ ok: true, value: 'started' });
    expect(test.control.state.getState().agentsById.started).toMatchObject({ agentId: 'started' });
    expect(test.runs.clearPreview).toHaveBeenCalledWith('started');
    expect(test.runs.refresh).toHaveBeenCalledOnce();
  });
});
