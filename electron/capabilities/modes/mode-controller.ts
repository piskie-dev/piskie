import { z } from 'zod';
import { MODE_OPERATIONS } from '../../../shared/electron-contracts/modes.js';
import type { AgentModeCatalog } from '../../agent/modes/agent-mode-catalog.js';
import { AgentModeCatalogError } from '../../agent/modes/agent-mode-catalog.js';
import type { OperationDefinition } from '../catalog.js';
import { PublicOperationError } from '../public-errors.js';

const querySchema = z.object({
  agentType: z.string().min(1).max(512).optional(),
}).strict().optional();

export function createModeController(catalog: AgentModeCatalog): readonly OperationDefinition[] {
  return Object.freeze([{
    id: MODE_OPERATIONS.listAvailable,
    capability: 'modes',
    input: z.tuple([querySchema]),
    execute: (_context, [query]) => {
      try {
        return catalog.listAvailable(query);
      } catch (error) {
        if (error instanceof AgentModeCatalogError) {
          throw new PublicOperationError(error.code, error.message);
        }
        throw error;
      }
    },
  }]);
}
