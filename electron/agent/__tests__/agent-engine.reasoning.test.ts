import { describe, expect, it, vi } from 'vitest';
import type { AgentControlState, ConversationEntry } from '../../../shared/types/agent-control.js';
import type { AgentInputEvent } from '../../../shared/types/index.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { AgentEngine } from '../agent-engine.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

class ReasoningMemoryEngine extends AgentEngine {
  readonly entries: ConversationEntry[] = [];

  constructor() {
    super();
    this.id = 'agent-test';
    this.mainAgentId = this.id;
    this.currentModel = 'provider::model-a';
    this.currentTarget = { providerId: 'provider', modelId: 'model-a' };
    this.tokenManager = { setTarget: vi.fn() } as never;
    this.context = { setTarget: vi.fn() } as never;
    this.inference = fakeAgentInference({
      resolveReasoning: (target, override) => ({
        selection: override ?? (target.modelId === 'model-b'
          ? { kind: 'effort', effort: 'low' }
          : { kind: 'effort', effort: 'medium' }),
        source: override ? 'agent' : 'model',
        nativeParameters: {},
      }),
    });
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return { reasoningOverride: this.reasoningOverride } as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  protected appendConversationEntry(entry: ConversationEntry): void { this.entries.push(entry); }
}

describe('AgentEngine active-flow reasoning snapshots', () => {
  it('snapshots the configured value on first model use and remembers explicit changes for this active flow', () => {
    const engine = new ReasoningMemoryEngine();
    const high = { kind: 'effort', effort: 'high' } as const;
    const low = { kind: 'effort', effort: 'low' } as const;

    engine.setReasoningOverride(high);
    engine.setModel('provider::model-b');
    expect(engine.reasoningOverride).toEqual({ kind: 'effort', effort: 'low' });

    engine.setReasoningOverride(low);
    engine.setModel('provider::model-a');
    expect(engine.reasoningOverride).toEqual(high);

    engine.setModel('provider::model-b');
    expect(engine.reasoningOverride).toEqual(low);
  });

  it('keeps model-addressed memory runtime-local instead of persisting it across a restore', () => {
    const engine = new ReasoningMemoryEngine();
    engine.setReasoningOverride({ kind: 'effort', effort: 'medium' });

    expect(engine.entries).toContainEqual(expect.objectContaining({
      t: 'marker',
      key: 'reasoningOverride',
      value: { kind: 'effort', effort: 'medium' },
    }));
    expect(engine.entries).not.toContainEqual(expect.objectContaining({ key: 'reasoningByModel' }));
  });

  it('resolves a reset into an explicit configured snapshot instead of leaving undefined state', () => {
    const engine = new ReasoningMemoryEngine();
    engine.setReasoningOverride({ kind: 'effort', effort: 'high' });

    engine.setReasoningOverride(undefined);

    expect(engine.reasoningOverride).toEqual({ kind: 'effort', effort: 'medium' });
  });
});
