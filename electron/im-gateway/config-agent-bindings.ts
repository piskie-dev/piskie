import type { ConfigPatchOperation } from '../../shared/types/config.js';
import type {
  MessagingAgentBinding,
  MessagingAgentBindings,
  MessagingPeerKind,
} from '../../shared/types/im-gateway.js';
import type { ConfigHost } from '../config/host/config-host.js';
import {
  escapeConfigPointer,
  mutateConfig,
} from '../config/host/config-mutations.js';

export interface MessagingConversation {
  botId: string;
  peerKind: MessagingPeerKind;
  peerId: string;
}

interface ImBotsBindingSnapshot {
  revision: number;
  agentBindings: MessagingAgentBindings;
}

/** Reads and updates IM conversation bindings through the canonical Config Domain. */
export class ConfigAgentBindings {
  constructor(private readonly config: ConfigHost) {}

  async get(conversation: MessagingConversation): Promise<string | null> {
    const snapshot = await this.config.show<ImBotsBindingSnapshot>('im-bots');
    return findBinding(snapshot.agentBindings[conversation.botId], conversation)?.agentId ?? null;
  }

  set(conversation: MessagingConversation, agentId: string): Promise<void> {
    return mutateConfig<ImBotsBindingSnapshot>(this.config, 'im-bots', (snapshot) => {
      const current = snapshot.agentBindings[conversation.botId] ?? [];
      const existing = findBinding(current, conversation);
      if (existing?.agentId === agentId) return [];

      const next = [
        ...current.filter((binding) => !sameConversation(binding, conversation)),
        { peerKind: conversation.peerKind, peerId: conversation.peerId, agentId },
      ];
      const botPath = `/agentBindings/${escapeConfigPointer(conversation.botId)}`;
      return [{
        op: Object.hasOwn(snapshot.agentBindings, conversation.botId) ? 'replace' : 'add',
        path: botPath,
        value: next,
      }];
    }).then(() => undefined);
  }

  removeAgent(agentId: string): Promise<void> {
    return mutateConfig<ImBotsBindingSnapshot>(this.config, 'im-bots', (snapshot) => {
      const patch: ConfigPatchOperation[] = [];
      for (const [botId, current] of Object.entries(snapshot.agentBindings)) {
        const next = current.filter((binding) => binding.agentId !== agentId);
        if (next.length === current.length) continue;
        const path = `/agentBindings/${escapeConfigPointer(botId)}`;
        patch.push(next.length > 0
          ? { op: 'replace', path, value: next }
          : { op: 'remove', path });
      }
      return patch;
    }).then(() => undefined);
  }
}

function findBinding(
  bindings: readonly MessagingAgentBinding[] | undefined,
  conversation: MessagingConversation,
): MessagingAgentBinding | undefined {
  return bindings?.find((binding) => sameConversation(binding, conversation));
}

function sameConversation(
  binding: Pick<MessagingAgentBinding, 'peerKind' | 'peerId'>,
  conversation: Pick<MessagingConversation, 'peerKind' | 'peerId'>,
): boolean {
  return binding.peerKind === conversation.peerKind && binding.peerId === conversation.peerId;
}
