import { z } from 'zod';
import {
  OBSERVABILITY_OPERATIONS,
  OBSERVABILITY_TOPICS,
} from '../../../shared/electron-contracts/observability.js';
import type { SystemLogQuery } from '../../../shared/types/index.js';
import type {
  ControllerContext,
  OperationDefinition,
  TopicDefinition,
} from '../catalog.js';
import { args, identifier, nonNegativeInteger } from '../validation.js';
import type { ObservabilityApplication } from './observability-application.js';

const logFilterSchema = z.object({
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
  levels: z.array(z.enum(['debug', 'info', 'warn', 'error'])).max(4).optional(),
  scopes: z.array(z.string().max(256)).max(1_000).optional(),
  events: z.array(z.string().max(256)).max(1_000).optional(),
  searchText: z.string().max(8_192).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  offset: nonNegativeInteger.optional(),
}).partial().optional();
const clientLogSchema = z.object({
  event: z.literal('config.domain.refresh.failed'),
  context: z.object({ domain: z.string().trim().min(1).max(128) }).strict(),
}).strict();

export function createObservabilityController(
  application: ObservabilityApplication,
): {
  operations: readonly OperationDefinition[];
  topics: readonly TopicDefinition[];
} {
  const operations: OperationDefinition[] = [
    operation(OBSERVABILITY_OPERATIONS.clearIncident, args([identifier]), (_context, [incidentId]) => (
      application.clearIncident(incidentId)
    )),
    operation(OBSERVABILITY_OPERATIONS.clearIncidents, args([]), () => application.clearIncidents()),
    operation(OBSERVABILITY_OPERATIONS.querySystemLogs, args([logFilterSchema]), (_context, [filter]) => (
      application.querySystemLogs(filter as SystemLogQuery | undefined)
    )),
    operation(OBSERVABILITY_OPERATIONS.systemLogFiles, args([]), () => application.systemLogFiles()),
    operation(
      OBSERVABILITY_OPERATIONS.exportSystemLogs,
      args([logFilterSchema, z.string().trim().min(1).max(512)]),
      (context, [filter, suggestedName]) => application.exportSystemLogs(
        context.windowId,
        (filter ?? {}) as SystemLogQuery,
        suggestedName,
      ),
    ),
    operation(OBSERVABILITY_OPERATIONS.listOccupancy, args([]), () => application.listOccupancy()),
    operation(
      OBSERVABILITY_OPERATIONS.recordClientLog,
      args([clientLogSchema]),
      (context, [input]) => application.recordClientLog(
        context.connectionId,
        context.windowId,
        input,
      ),
    ),
  ];

  const topics: TopicDefinition[] = [
    {
      id: OBSERVABILITY_TOPICS.incidents,
      capability: 'observability',
      input: z.undefined(),
      open(context, _input, emit) {
        const dispose = application.observeIncidents(emit, context.signal);
        return { snapshot: application.incidentSnapshot(), dispose };
      },
    },
    {
      id: OBSERVABILITY_TOPICS.occupancy,
      capability: 'observability',
      input: z.undefined(),
      open(context, _input, emit) {
        const dispose = application.occupancyChanges().subscribe(emit, { signal: context.signal });
        return { snapshot: application.listOccupancy(), dispose };
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
  execute: (context: ControllerContext, input: any[]) => unknown,
): OperationDefinition<unknown[]> {
  return { id, capability: 'observability', input, execute };
}
