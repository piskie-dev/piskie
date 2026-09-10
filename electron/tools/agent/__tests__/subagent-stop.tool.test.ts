import { describe, expect, it, vi } from 'vitest';
import { SubagentStopTool, subagentStopSchema } from '../subagent-stop.tool.js';
import { parse } from '../../params.js';
import type { ToolContext } from '../../types.js';

describe('subagent_stop tool', () => {
  it('requires only the full subagentId', () => {
    expect(parse(subagentStopSchema, { subagentId: 'worker-a' })).toEqual({ ok: true, value: { subagentId: 'worker-a' } });
    expect(parse(subagentStopSchema, {}).ok).toBe(false);
    expect(parse(subagentStopSchema, { subagentId: ' ' }).ok).toBe(false);
    expect(parse(subagentStopSchema, { subagentId: 'worker-a', action: 'stop' }).ok).toBe(false);
  });

  it('destroys the Worker through the subagent port', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const result = await new SubagentStopTool().execute({ subagentId: 'worker-a' }, {
      subagents: { create: vi.fn(), destroy, traceFilePath: vi.fn() },
    } as unknown as ToolContext);
    expect(destroy).toHaveBeenCalledWith('worker-a');
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('worker-a') });
  });

  it('reports destroy failures and a missing subagent service', async () => {
    const failed = await new SubagentStopTool().execute({ subagentId: 'worker-a' }, {
      subagents: { create: vi.fn(), destroy: vi.fn().mockRejectedValue(new Error('not found')), traceFilePath: vi.fn() },
    } as unknown as ToolContext);
    expect(failed).toMatchObject({ ok: false, text: expect.stringContaining('not found') });
    const missing = await new SubagentStopTool().execute({ subagentId: 'worker-a' }, {} as unknown as ToolContext);
    expect(missing.ok).toBe(false);
  });
});
