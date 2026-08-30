import type { ResolvedAgentLaunch } from '../agent/launch/resolved-agent-launch.js';
import type { IMAgentCommands } from './agent-ports.js';
import type { MessagingConversation } from './config-agent-bindings.js';

export interface MessagingAgentBindingPort {
  get(conversation: MessagingConversation): Promise<string | null>;
  set(conversation: MessagingConversation, agentId: string): Promise<void>;
}

export type MessagingAgentLaunchResolver = () => ResolvedAgentLaunch;

export class MessagingAgentSession {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly agents: IMAgentCommands,
    private readonly bindings: MessagingAgentBindingPort,
  ) {}

  ensure(
    conversation: MessagingConversation,
    resolveLaunch: MessagingAgentLaunchResolver,
  ): Promise<string> {
    return this.withConversationLock(conversation, async () => {
      const existingAgentId = await this.bindings.get(conversation);
      if (existingAgentId) {
        if (this.agents.hasAgentInMemory(existingAgentId)) return existingAgentId;
        const resumed = await this.agents.resumeAgent(existingAgentId, { autoStart: false });
        if (resumed) return resumed.agentId;
      }
      return this.startAndBind(conversation, resolveLaunch());
    });
  }

  startNew(conversation: MessagingConversation, launch: ResolvedAgentLaunch): Promise<string> {
    return this.withConversationLock(conversation, async () => {
      const existingAgentId = await this.bindings.get(conversation);
      if (existingAgentId && this.agents.hasAgentInMemory(existingAgentId)) {
        await this.agents.stopAgent(existingAgentId);
      }
      return this.startAndBind(conversation, launch);
    });
  }

  private async startAndBind(
    conversation: MessagingConversation,
    launch: ResolvedAgentLaunch,
  ): Promise<string> {
    const state = await this.agents.startAgent(launch);
    try {
      await this.bindings.set(conversation, state.agentId);
    } catch (error) {
      try {
        await this.agents.stopAgent(state.agentId);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          'Failed to persist the Messaging Agent binding and stop the unbound AgentRun',
        );
      }
      throw error;
    }
    return state.agentId;
  }

  private async withConversationLock<T>(
    conversation: MessagingConversation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([conversation.botId, conversation.peerKind, conversation.peerId]);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => turn);
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
