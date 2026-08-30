import type { AgentControlState } from '../../shared/types/agent-control.js';
import type { ConversationAppendEvent } from '../../shared/types/index.js';
import type { AgentContentEvent } from '../tools/types.js';
import type { AgentLiveContentDelta } from '../../shared/electron-contracts/agents.js';
import {
  createChangeChannel,
  type ChangeSource,
} from '../core/change-channel.js';

export interface AgentControlStateChanged {
  agentId: string;
  state: AgentControlState;
}

export interface AgentRuntimeReleased {
  agentId: string;
  reason: 'stopped' | 'deleted' | 'failed-start' | 'shutdown';
}

export type AgentOutputObserved = AgentContentEvent & { agentId: string };

export interface AgentObservationSource {
  readonly controlStateChanges: ChangeSource<AgentControlStateChanged>;
  readonly runtimeReleases: ChangeSource<AgentRuntimeReleased>;
  readonly conversationAppends: ChangeSource<ConversationAppendEvent>;
  readonly outputs: ChangeSource<AgentOutputObserved>;
  readonly liveContentDeltas: ChangeSource<AgentLiveContentDelta>;
}

export interface AgentRuntimeObserver {
  stateChanged(state: AgentControlState): void;
  contentProduced(event: AgentContentEvent): void;
  liveContentProduced(event: AgentLiveContentDelta): void;
}

export type AgentRuntimeObserverFactory = (agentId: string) => AgentRuntimeObserver;

export interface AgentObservationPublisher {
  controlStateChanged(change: AgentControlStateChanged): void;
  runtimeReleased(change: AgentRuntimeReleased): void;
  conversationAppended(change: ConversationAppendEvent): void;
  outputObserved(change: AgentOutputObserved): void;
  liveContentObserved(change: AgentLiveContentDelta): void;
  observerFor(agentId: string): AgentRuntimeObserver;
}

export interface AgentObservations {
  source: AgentObservationSource;
  publisher: AgentObservationPublisher;
}

export function createAgentObservations(
  onSubscriberError?: (source: keyof AgentObservationSource, error: unknown) => void,
): AgentObservations {
  const controlStateChanges = createChangeChannel<AgentControlStateChanged>({
    onSubscriberError: (error) => onSubscriberError?.('controlStateChanges', error),
  });
  const runtimeReleases = createChangeChannel<AgentRuntimeReleased>({
    onSubscriberError: (error) => onSubscriberError?.('runtimeReleases', error),
  });
  const conversationAppends = createChangeChannel<ConversationAppendEvent>({
    onSubscriberError: (error) => onSubscriberError?.('conversationAppends', error),
  });
  const outputs = createChangeChannel<AgentOutputObserved>({
    onSubscriberError: (error) => onSubscriberError?.('outputs', error),
  });
  const liveContentDeltas = createChangeChannel<AgentLiveContentDelta>({
    onSubscriberError: (error) => onSubscriberError?.('liveContentDeltas', error),
  });

  const publisher: AgentObservationPublisher = Object.freeze({
    controlStateChanged: (change: AgentControlStateChanged) => controlStateChanges.sink.publish(change),
    runtimeReleased: (change: AgentRuntimeReleased) => runtimeReleases.sink.publish(change),
    conversationAppended: (change: ConversationAppendEvent) => conversationAppends.sink.publish(change),
    outputObserved: (change: AgentOutputObserved) => outputs.sink.publish(change),
    liveContentObserved: (change: AgentLiveContentDelta) => liveContentDeltas.sink.publish(change),
    observerFor: (agentId: string) => ({
      stateChanged: (state: AgentControlState) => controlStateChanges.sink.publish({ agentId, state }),
      contentProduced: (event: AgentContentEvent) => outputs.sink.publish({ agentId, ...event }),
      liveContentProduced: (event: AgentLiveContentDelta) => liveContentDeltas.sink.publish(event),
    }),
  });

  return Object.freeze({
    source: Object.freeze({
      controlStateChanges: controlStateChanges.source,
      runtimeReleases: runtimeReleases.source,
      conversationAppends: conversationAppends.source,
      outputs: outputs.source,
      liveContentDeltas: liveContentDeltas.source,
    }),
    publisher,
  });
}
