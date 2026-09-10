import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sample-contract-app', getAppPath: () => '/tmp/sample-contract-app' } }));

import { ToolCallContextFactory } from '../../agent/tool-call/context-builder.js';
import { PendingSettlement } from '../../agent/tool-call/pending-settlement.js';
import type { Settler } from '../../agent/conversation/settler.js';
import { specRegistry } from '../../agent/specs/index.js';
import { getStandaloneToolCatalog } from '../index.js';
import { ToolCoordinator } from '../coordinator.js';
import type { EventPort } from '../types.js';

function fixture() {
  const spec = specRegistry.get('explore')!;
  const catalog = getStandaloneToolCatalog();
  const face = {
    scope: 'subagent' as const, agentType: 'worker' as const, customTools: spec.tools.customTools,
    toolOptions: spec.tools.options, exposedSkillFunctions: [], excluded: new Set<string>(), domains: new Set<'local'>(['local']),
  };
  const snapshot = catalog.snapshot(face);
  const events: EventPort = { allowedTargets: () => ['parent-a'], notifyParent: vi.fn(() => true), send: vi.fn(() => false) };
  const contexts = new ToolCallContextFactory({ signal: () => new AbortController().signal, activation: {
    agentType: 'worker', agentSpec: 'explore', agentId: 'worker-a', mainAgentId: 'parent-a',
    runConfig: { name: 'Sample', description: '', promptTemplate: '' }, resourceIds: {},
    currentModel: () => 'sample::model', workspace: { dir: '/workspace', tempDir: '/tmp/sample-worker' },
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' }, events, post: () => true,
  } });
  const coordinator = new ToolCoordinator({ contexts });
  return { catalog, face, snapshot, events, coordinator };
}

describe('resolved tool contracts at execution', () => {
  it.each(['completed', 'failed', 'user_stopped'])('delivers allowed %s and stages the matching terminal outcome', async (type) => {
    const { snapshot, coordinator, events } = fixture();
    const pending = await coordinator.run({ modelName: 'send_event', callId: 'event-a', rawParams: { type, message: 'Sample result and evidence.' } }, snapshot);
    expect(pending).toMatchObject({ result: { ok: true } });
    expect(events.notifyParent).toHaveBeenCalledWith(expect.objectContaining({ type }));
    expect(pending).toBeInstanceOf(PendingSettlement);
    if (!(pending instanceof PendingSettlement)) throw new Error('Expected settlement');
    const settled = pending.commit({ settleLive: () => 'inserted' } as unknown as Settler);
    expect(settled.terminal).toBe(type);
  });

  it.each([
    { type: 'message' }, { type: 'need_user_action' }, { type: 'completed', targetId: 'parent-a' },
  ])('rejects excluded operations and fields before delivery: %j', async (input) => {
    const { snapshot, coordinator, events } = fixture();
    const pending = await coordinator.run({ modelName: 'send_event', callId: 'event-a', rawParams: { ...input, message: 'Sample result.' } }, snapshot);
    expect(pending).toMatchObject({ result: { ok: false } });
    expect(events.notifyParent).not.toHaveBeenCalled();
  });

  it('binds independent contracts for Workers sharing the same tool implementation', () => {
    const { catalog, face, snapshot } = fixture();
    const unrestricted = catalog.snapshot({ ...face, toolOptions: undefined });
    const explore = snapshot.definitions().find((tool) => tool.name === 'send_event')!;
    const general = unrestricted.definitions().find((tool) => tool.name === 'send_event')!;
    expect(explore.input_schema.properties.type).toMatchObject({ enum: ['completed', 'failed', 'user_stopped'] });
    expect(explore.description).not.toMatch(/need_user_action|message：/);
    expect(general.input_schema.properties.type).toMatchObject({ enum: ['message', 'completed', 'failed', 'user_stopped', 'need_user_action'] });
    expect(general.description).toContain('need_user_action');
    expect(snapshot.resolve('send_event')?.tool).toBe(unrestricted.resolve('send_event')?.tool);
  });

  it.each(['shell', 'write', 'skill_call', 'subagent', 'web_search'])('rejects the ungranted %s entry through the same coordinator', async (modelName) => {
    const { snapshot, coordinator } = fixture();
    expect(await coordinator.run({ modelName, callId: 'call-a', rawParams: {} }, snapshot))
      .toMatchObject({ result: { ok: false } });
  });
});
