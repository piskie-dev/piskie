import { z } from 'zod';

import {
  UPDATE_OPERATIONS,
  UPDATE_TOPICS,
} from '../../shared/electron-contracts/updates.js';
import type { OperationDefinition, TopicDefinition } from '../capabilities/catalog.js';
import { args } from '../capabilities/validation.js';
import type { UpdateApplication } from './update-application.js';

export function createUpdateController(
  application: UpdateApplication,
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(UPDATE_OPERATIONS.status, () => application.status()),
    operation(UPDATE_OPERATIONS.check, () => application.check()),
    operation(UPDATE_OPERATIONS.restartAndInstall, () => application.restartAndInstall()),
  ];
  const topics: TopicDefinition[] = [{
    id: UPDATE_TOPICS.status,
    capability: 'updates',
    input: z.undefined(),
    open(context, _input, emit) {
      return {
        snapshot: application.status(),
        dispose: application.changes.subscribe(emit, { signal: context.signal }),
      };
    },
  }];
  return Object.freeze({
    operations: Object.freeze(operations),
    topics: Object.freeze(topics),
  });
}

function operation(
  id: string,
  execute: () => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'updates',
    input: args([]),
    execute,
  };
}
