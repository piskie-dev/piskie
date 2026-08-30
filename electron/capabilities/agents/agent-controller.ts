import { z } from 'zod';
import {
  AGENT_OPERATIONS,
  AGENT_TOPICS,
} from '../../../shared/electron-contracts/agents.js';
import { agentInputRequestSchema } from '../../../shared/schemas/agent-input.js';
import type {
  ConversationAppendEvent,
  AgentInputEvent,
  ToolApprovalDecision,
} from '../../../shared/types/index.js';
import type {
  AgentLiveContentDelta,
  StartAgentRequest,
} from '../../../shared/electron-contracts/agents.js';
import type { AgentControlChangedEvent } from '../../../shared/electron-contracts/agent-runs.js';
import type { ReasoningSelection } from '../../../shared/types/reasoning.js';
import type { AgentService } from '../../services/agent.service.js';
import {
  AgentModeCatalogError,
  type AgentModeCatalog,
} from '../../agent/modes/agent-mode-catalog.js';
import type { ControllerContext, OperationDefinition, TopicDefinition } from '../catalog.js';
import { PublicOperationError } from '../public-errors.js';
import { args, identifier, nonNegativeInteger } from '../validation.js';
import {
  agentControlChangedEvent,
  agentControlSnapshot,
  agentControlSnapshots,
} from '../agent-runs/public-agent-run-view.js';

const launchSchema = z.object({
  initialModel: identifier.optional(),
  mcpPrewarmToken: identifier.optional(),
  images: z.array(z.object({
    data: z.string().min(1).max(64 * 1024 * 1024),
    media_type: identifier,
  }).strict()).max(32).optional(),
}).strict().optional();
const startCommonFields = {
  workspace: z.string().max(16_384).optional(),
  approvalMode: z.enum(['auto', 'confirm']).optional(),
  environmentIds: z.array(identifier).max(128).optional(),
  launchOptions: launchSchema,
};
const startRequestSchema = z.union([
  z.object({
    ...startCommonFields,
    definitionId: identifier,
    modeId: z.enum(['normal', 'plan']).optional(),
  }).strict(),
  z.object({
    ...startCommonFields,
    input: z.string().max(1_000_000),
    modeId: z.enum(['normal', 'plan', 'browser-skill']),
  }).strict(),
]);
const reasoningSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider-default') }),
  z.object({ kind: z.literal('disabled') }),
  z.object({ kind: z.literal('enabled') }),
  z.object({
    kind: z.literal('effort'),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  }),
  z.object({ kind: z.literal('budget'), tokens: z.number().int().positive() }),
]).nullable();
const decisionSchema = z.object({
  callId: identifier,
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(8_192).optional(),
  feedback: z.string().max(64_000).optional(),
  changeToAuto: z.boolean().optional(),
  images: z.array(z.object({
    data: z.string().min(1).max(64 * 1024 * 1024),
    media_type: identifier,
  })).max(32).optional(),
}).passthrough();
const modelTargetSchema = z.object({
  providerId: identifier,
  modelId: identifier,
});
const conversationPageSchema = z.discriminatedUnion('direction', [
  z.object({
    direction: z.literal('tail'),
    limit: z.number().int().min(1).max(500),
  }).strict(),
  z.object({
    direction: z.literal('forward'),
    from: nonNegativeInteger,
    limit: z.number().int().min(1).max(500),
  }).strict(),
  z.object({
    direction: z.literal('backward'),
    before: nonNegativeInteger,
    limit: z.number().int().min(1).max(500),
  }).strict(),
]);

export function createAgentController(
  agent: AgentService,
  modes: AgentModeCatalog,
): {
  operations: readonly OperationDefinition[];
  topics: readonly TopicDefinition[];
} {
  const operations: OperationDefinition[] = [
    operation(AGENT_OPERATIONS.start, args([startRequestSchema]), async ([request]) => {
      const state = await callModeCatalog(() => modes.start(request as StartAgentRequest));
      return agentControlSnapshot(state);
    }),
    operation(AGENT_OPERATIONS.setMode, args([identifier, identifier]), async ([agentId, modeId]) => {
      await callModeCatalog(async () => modes.setMode(agentId, modeId));
    }),
    operation(AGENT_OPERATIONS.listStates, args([]), () => {
      const states = agent.getLoadedControlStates();
      return agentControlSnapshots(states);
    }),
    operation(AGENT_OPERATIONS.stop, args([identifier]), async ([agentId]) => {
      await agent.stopAgent(agentId);
    }),
    operation(AGENT_OPERATIONS.resume, args([identifier]), async ([agentId]) => {
      const state = await agent.resumeAgent(agentId);
      return state ? agentControlSnapshot(state) : null;
    }),
    operation(AGENT_OPERATIONS.inject, args([identifier, agentInputRequestSchema]), async ([agentId, event]) => {
      const accepted = await agent.injectEventToAgent(agentId, event as AgentInputEvent);
      if (!accepted) notFound('Agent is unavailable for event injection');
    }),
    operation(
      AGENT_OPERATIONS.injectSubagent,
      args([identifier, identifier, agentInputRequestSchema]),
      async ([agentId, subagentId, event]) => {
        const accepted = await agent.injectEventToSubagent(
          agentId,
          subagentId,
          event as AgentInputEvent,
        );
        if (!accepted) notFound('Agent or subagent was not found');
      },
    ),
    operation(AGENT_OPERATIONS.setModel, args([identifier, identifier]), ([agentId, model]) => {
      if (!agent.setAgentModel(agentId, model)) notFound('Agent was not found');
    }),
    operation(
      AGENT_OPERATIONS.setSubagentModel,
      args([identifier, identifier, identifier]),
      ([agentId, subagentId, model]) => {
        if (!agent.setSubagentModel(agentId, subagentId, model)) {
          notFound('Agent or subagent was not found');
        }
      },
    ),
    operation(
      AGENT_OPERATIONS.setReasoning,
      args([identifier, reasoningSchema]),
      ([agentId, selection]) => {
        if (!agent.setAgentReasoning(agentId, (selection ?? undefined) as ReasoningSelection | undefined)) {
          notFound('Agent was not found');
        }
      },
    ),
    operation(
      AGENT_OPERATIONS.setSubagentReasoning,
      args([identifier, identifier, reasoningSchema]),
      ([agentId, subagentId, selection]) => {
        if (!agent.setSubagentReasoning(
          agentId,
          subagentId,
          (selection ?? undefined) as ReasoningSelection | undefined,
        )) {
          notFound('Agent or subagent was not found');
        }
      },
    ),
    operation(AGENT_OPERATIONS.interrupt, args([identifier]), async ([agentId]) => {
      await agent.instantInterrupt(agentId);
    }),
    operation(
      AGENT_OPERATIONS.interruptSubagent,
      args([identifier, identifier]),
      async ([agentId, subagentId]) => {
        await agent.instantInterruptSubagent(agentId, subagentId);
      },
    ),
    operation(
      AGENT_OPERATIONS.conversation,
      args([identifier, conversationPageSchema]),
      ([agentId, page]) => readConversation(agent, agentId, page),
    ),
    operation(AGENT_OPERATIONS.context, args([identifier]), ([agentId]) => {
      const runtime = agent.findAgentById(agentId);
      if (!runtime) notFound('Agent was not found');
      return runtime.buildContextSnapshot();
    }),
    operation(
      AGENT_OPERATIONS.setApprovalMode,
      args([identifier, z.enum(['auto', 'confirm'])]),
      ([agentId, mode]) => {
        if (!agent.setAgentApprovalMode(agentId, mode)) notFound('Agent was not found');
      },
    ),
    operation(
      AGENT_OPERATIONS.setSubagentApprovalMode,
      args([identifier, identifier, z.enum(['auto', 'confirm'])]),
      ([agentId, subagentId, mode]) => {
        if (!agent.setSubagentApprovalMode(agentId, subagentId, mode)) {
          notFound('Agent or subagent was not found');
        }
      },
    ),
    operation(
      AGENT_OPERATIONS.respondToApproval,
      args([identifier, identifier.optional(), decisionSchema]),
      async ([agentId, subagentId, decision]) => {
        if (!await agent.respondToApproval(
          agentId,
          subagentId ?? null,
          decision as ToolApprovalDecision,
        )) {
          notFound('Agent or approval request was not found');
        }
      },
    ),
    operation(
      AGENT_OPERATIONS.promoteToolToBackground,
      args([identifier]),
      ([callId]) => agent.promoteToolToBackground(callId),
    ),
    operation(AGENT_OPERATIONS.approveImages, args([identifier, identifier]), ([agentId, nodeId]) => {
      assertImageAction(findRuntime(agent, agentId).respondToImageApproval(nodeId));
    }),
    operation(AGENT_OPERATIONS.enterImageEdit, args([identifier, identifier]), ([agentId, nodeId]) => {
      assertImageAction(findRuntime(agent, agentId).enterImageEdit(nodeId));
    }),
    operation(
      AGENT_OPERATIONS.regenerateImages,
      args([z.object({
        agentId: identifier,
        nodeId: identifier,
        imageIds: z.array(identifier).max(128),
        instruction: z.string().min(1).max(64_000),
        target: modelTargetSchema.optional(),
        images: z.array(z.object({
          data: z.string().min(1).max(64 * 1024 * 1024),
          media_type: identifier,
        })).max(32).optional(),
      }).passthrough()]),
      ([input]) => {
        assertImageAction(findRuntime(agent, input.agentId).regenerateImage(
          input.nodeId,
          input.imageIds,
          input.instruction,
          input.target,
          input.images,
        ));
      },
    ),
    operation(
      AGENT_OPERATIONS.cancelImages,
      args([identifier, identifier, z.string().max(8_192).optional()]),
      ([agentId, nodeId, reason]) => {
        assertImageAction(findRuntime(agent, agentId).cancelImageReview(nodeId, reason));
      },
    ),
    operation(
      AGENT_OPERATIONS.deleteImage,
      args([identifier, identifier, identifier]),
      ([agentId, nodeId, imageId]) => {
        assertImageAction(findRuntime(agent, agentId).deleteImage(nodeId, imageId));
      },
    ),
    operation(
      AGENT_OPERATIONS.changeImageModel,
      args([identifier, identifier, modelTargetSchema]),
      ([agentId, nodeId, target]) => {
        assertImageAction(findRuntime(agent, agentId).changeImageModel(nodeId, target));
      },
    ),
  ];

  const topics: TopicDefinition[] = [
    {
      id: AGENT_TOPICS.state,
      capability: 'agents',
      input: z.undefined(),
      open(context, _input, emit) {
        const releaseState = agent.observations.controlStateChanges.subscribe(
          (event) => {
            emit(agentControlChangedEvent(event));
          },
          { signal: context.signal },
        );
        const releaseRuntime = agent.observations.runtimeReleases.subscribe(
          ({ agentId }) => emit({ agentId, state: null } satisfies AgentControlChangedEvent),
          { signal: context.signal },
        );
        const snapshot = agent.getLoadedControlStates();
        return {
          snapshot: agentControlSnapshots(snapshot),
          dispose: () => {
            releaseState();
            releaseRuntime();
          },
        };
      },
    },
    {
      id: AGENT_TOPICS.conversation,
      capability: 'agents',
      input: z.undefined(),
      open(context, _input, emit) {
        const dispose = agent.observations.conversationAppends.subscribe((event) => {
          emit(event satisfies ConversationAppendEvent);
        }, {
          signal: context.signal,
        });
        return { snapshot: null, dispose };
      },
    },
    {
      id: AGENT_TOPICS.liveContent,
      capability: 'agents',
      input: z.undefined(),
      open(context, _input, emit) {
        const dispose = agent.observations.liveContentDeltas.subscribe(
          (event) => emit(event satisfies AgentLiveContentDelta),
          { signal: context.signal },
        );
        return { snapshot: null, dispose };
      },
    },
  ];

  return Object.freeze({
    operations: Object.freeze(operations),
    topics: Object.freeze(topics),
  });
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[], context: ControllerContext) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'agents',
    input,
    execute: (context, value) => execute(value, context),
  };
}

async function callModeCatalog<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentModeCatalogError) {
      throw new PublicOperationError(error.code, error.message);
    }
    throw error;
  }
}

function findRuntime(agent: AgentService, agentId: string) {
  const runtime = agent.findAgentById(agentId);
  if (!runtime) notFound('Agent was not found');
  return runtime;
}

function readConversation(
  agent: AgentService,
  agentId: string,
  page: z.infer<typeof conversationPageSchema>,
) {
  const store = agent.getConversationStore();
  const mainAgentId = agent.resolveMainAgentId(agentId);
  if (!mainAgentId) notFound('Agent was not found');
  const result = store.readPage(mainAgentId, agentId, page);
  return {
    from: result.from,
    entries: result.entries
      .map((entry) => store.absolutizeImageRefs(mainAgentId, agentId, entry)),
    total: result.total,
  };
}

function assertImageAction(result: { success: boolean; error?: string }): void {
  if (!result.success) {
    throw new PublicOperationError('conflict', result.error ?? 'Image action was rejected');
  }
}

function notFound(message: string): never {
  throw new PublicOperationError('not-found', message);
}
