import { z } from 'zod';
import { AGENT_RUN_OPERATIONS } from '../../../shared/electron-contracts/agent-runs.js';
import type { ControllerContext, OperationDefinition } from '../catalog.js';
import { args, identifier, nonNegativeInteger } from '../validation.js';
import type { AgentRunApplication } from './agent-run-application.js';

export function createAgentRunController(
  application: AgentRunApplication,
): readonly OperationDefinition[] {
  return Object.freeze([
    operation(AGENT_RUN_OPERATIONS.list, args([]), () => application.list()),
    operation(AGENT_RUN_OPERATIONS.state, args([identifier]), ([agentId]) => (
      application.state(agentId)
    )),
    operation(AGENT_RUN_OPERATIONS.delete, args([identifier]), ([agentId]) => (
      application.delete(agentId)
    )),
    operation(AGENT_RUN_OPERATIONS.readPlan, args([identifier]), ([agentId]) => (
      application.readPlan(agentId)
    )),
    operation(AGENT_RUN_OPERATIONS.listCompactions, args([identifier]), ([agentId]) => (
      application.listCompactions(agentId)
    )),
    operation(
      AGENT_RUN_OPERATIONS.originalCompactionMessages,
      args([z.object({
        agentId: identifier,
        summaryId: identifier,
        offset: nonNegativeInteger.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }).strict()]),
      ([input]) => application.originalMessages(input),
    ),
  ]);
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[], context: ControllerContext) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'agent-runs',
    input,
    execute: (context, value) => execute(value, context),
  };
}
