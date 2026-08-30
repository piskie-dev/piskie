import { describe, expect, it, vi } from 'vitest';
import { createAgentObservations } from '../observations.js';

describe('Agent observations', () => {
  it('binds runtime identity without exposing application publish capability', () => {
    const observations = createAgentObservations();
    const states: unknown[] = [];
    const outputs: unknown[] = [];
    observations.source.controlStateChanges.subscribe((change) => states.push(change));
    observations.source.outputs.subscribe((change) => outputs.push(change));

    const observer = observations.publisher.observerFor('agent-1');
    const state = { phase: 'waiting' } as never;
    observer.stateChanged(state);
    observer.contentProduced({ type: 'assistant_text', content: 'working' });

    expect(states).toEqual([{ agentId: 'agent-1', state }]);
    expect(outputs).toEqual([{ agentId: 'agent-1', type: 'assistant_text', content: 'working' }]);
    expect('publish' in observations.source.outputs).toBe(false);
  });

  it('keeps control state and runtime release as separate facts', () => {
    const observations = createAgentObservations();
    const states: unknown[] = [];
    const releases: unknown[] = [];
    observations.source.controlStateChanges.subscribe((change) => states.push(change));
    observations.source.runtimeReleases.subscribe((change) => releases.push(change));

    observations.publisher.controlStateChanged({
      agentId: 'agent-1',
      state: { phase: 'stopping' } as never,
    });
    observations.publisher.runtimeReleased({
      agentId: 'agent-1',
      reason: 'shutdown',
    });

    expect(states).toHaveLength(1);
    expect(releases).toEqual([{
      agentId: 'agent-1',
      reason: 'shutdown',
    }]);
  });

  it('isolates one failed output consumer from the remaining consumers', () => {
    const onSubscriberError = vi.fn();
    const observations = createAgentObservations(onSubscriberError);
    const healthy = vi.fn();
    observations.source.outputs.subscribe(() => {
      throw new Error('consumer failed');
    });
    observations.source.outputs.subscribe(healthy);

    expect(() => observations.publisher.outputObserved({
      agentId: 'agent-1',
      type: 'turn_end',
    })).not.toThrow();

    expect(healthy).toHaveBeenCalledOnce();
    expect(onSubscriberError).toHaveBeenCalledWith('outputs', expect.any(Error));
  });

  it('isolates a failed live-content consumer without dropping the delta', () => {
    const onSubscriberError = vi.fn();
    const observations = createAgentObservations(onSubscriberError);
    const healthy = vi.fn();
    observations.source.liveContentDeltas.subscribe(() => {
      throw new Error('renderer bridge failed');
    });
    observations.source.liveContentDeltas.subscribe(healthy);
    const delta = {
      agentId: 'agent-1',
      requestId: 'request-1',
      runId: 'run-1',
      attempt: 1,
      sequence: 1,
      kind: 'think' as const,
      delta: 'working',
    };

    expect(() => observations.publisher.liveContentObserved(delta)).not.toThrow();

    expect(healthy).toHaveBeenCalledWith(delta);
    expect(onSubscriberError).toHaveBeenCalledWith('liveContentDeltas', expect.any(Error));
  });

  it('stops high-volume delivery after the owning subscription is disposed', () => {
    const observations = createAgentObservations();
    const received = vi.fn();
    const unsubscribe = observations.source.outputs.subscribe(received);

    for (let index = 0; index < 10_000; index++) {
      observations.publisher.outputObserved({
        agentId: `agent-${index % 10}`,
        type: 'assistant_text',
        content: String(index),
      });
    }
    unsubscribe();
    observations.publisher.outputObserved({ agentId: 'agent-1', type: 'turn_end' });

    expect(received).toHaveBeenCalledTimes(10_000);
  });

  it('drops live deltas immediately after the window subscription is disposed', () => {
    const observations = createAgentObservations();
    const received = vi.fn();
    const unsubscribe = observations.source.liveContentDeltas.subscribe(received);
    const delta = {
      agentId: 'agent-1',
      requestId: 'request-1',
      runId: 'run-1',
      attempt: 1,
      sequence: 1,
      kind: 'text' as const,
      delta: 'visible',
    };

    observations.publisher.liveContentObserved(delta);
    unsubscribe();
    observations.publisher.liveContentObserved({ ...delta, sequence: 2, delta: 'late' });

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(delta);
  });
});
