import { describe, expect, it } from 'vitest';
import { resolveEffectiveReasoning } from '../../inference/ai/reasoning-policy.js';
import { resolveWorkerInference } from '../worker-inference.js';
import { listWorkerTypes } from '../specs/worker-catalog.js';
import type { AgentSpec } from '../specs/spec.js';
import type { WorkerPreferencesDocument } from '../../../shared/types/worker-preferences.js';

const preferences: WorkerPreferencesDocument = { schemaVersion: 1, revision: 1, profiles: {
  explore: { inference: { target: { providerId: 'configured', modelId: 'chosen' }, reasoning: { kind: 'effort', effort: 'low' } } },
} };
const inference = {
  assertTarget: ({ providerId }: { providerId: string }) => { if (providerId === 'gone') throw new Error('Target removed'); },
  resolveReasoning: (_target: unknown, override?: Parameters<typeof resolveEffectiveReasoning>[0]['agentOverride']) => resolveEffectiveReasoning({
    profile: { mode: 'effort', options: [{ kind: 'effort', effort: 'low' }, { kind: 'effort', effort: 'high' }],
      defaultSelection: { kind: 'effort', effort: 'low' }, mandatory: true, transportPreset: 'openai-effort', replayPolicy: 'none' },
    agentOverride: override,
  }),
};

describe('Worker creation inference', () => {
  it('ignores display remarks when resolving runtime preferences and type identity', () => {
    const input = { type: 'explore', parentModel: 'parent::model', parentReasoning: { kind: 'effort', effort: 'high' } } as const;
    const saved = structuredClone(preferences);
    const original = resolveWorkerInference(input, saved, inference);
    saved.profiles.explore!.displayName = 'Private remark';
    expect(resolveWorkerInference(input, saved, inference)).toEqual(original);
    expect(resolveWorkerInference({ ...input, type: 'Private remark' }, saved, inference)).toEqual({ model: input.parentModel, reasoning: input.parentReasoning });
  });

  it('uses exact Spec identity and snapshots preferences independently of parent/default changes', () => {
    const input = { type: 'explore', parentModel: 'parent::model', parentReasoning: { kind: 'effort', effort: 'high' } } as const;
    const saved = structuredClone(preferences);
    const created = resolveWorkerInference(input, saved, inference);
    expect(created).toEqual({ model: 'configured::chosen', reasoning: { kind: 'effort', effort: 'low' } });
    saved.profiles.explore!.inference!.reasoning = { kind: 'effort', effort: 'high' };
    expect(created.reasoning).toEqual({ kind: 'effort', effort: 'low' });
    expect(resolveWorkerInference(input, saved, inference).reasoning).toEqual({ kind: 'effort', effort: 'high' });
    for (const type of ['browser-worker', 'site-scout', 'browser-skill-builder', 'browser-skill-verifier', 'local-worker', 'new-type']) {
      expect(resolveWorkerInference({ ...input, type }, preferences, inference)).toEqual({ model: 'parent::model', reasoning: input.parentReasoning });
    }
    expect(resolveWorkerInference({ ...input, type: 'local-worker', parentModel: 'another::model' }, preferences, inference).model).toBe('another::model');
  });

  it('rejects explicit invalid preferences instead of falling back, preserving the failure reason', () => {
    const saved = structuredClone(preferences);
    const input = { type: 'explore', parentModel: 'parent::model', parentReasoning: { kind: 'effort', effort: 'high' } } as const;
    saved.profiles.explore!.inference!.target.providerId = 'gone';
    expect(() => resolveWorkerInference(input, saved, inference)).toThrow('Worker explore (gone::chosen): Target removed');
    saved.profiles.explore!.inference!.target.providerId = 'configured';
    saved.profiles.explore!.inference!.reasoning = { kind: 'effort', effort: 'max' };
    expect(() => resolveWorkerInference(input, saved, inference)).toThrow('Agent reasoning override is not valid');
  });

  it('projects all registered Workers without inferring type from browser resources or parent permissions', () => {
    const entries = [{ name: 'main', role: 'director' }, { name: 'protected', role: 'worker', allowedParentSpecs: ['special'] }] as AgentSpec[];
    const registry = { getAll: () => entries };
    expect(listWorkerTypes(registry)).toEqual([{ type: 'protected', description: 'protected' }]);
    entries.push({ name: 'future-worker', role: 'worker', subagentTypeDescription: 'New type' } as AgentSpec);
    expect(listWorkerTypes(registry).map((entry) => entry.type)).toEqual(['future-worker', 'protected']);
  });
});
