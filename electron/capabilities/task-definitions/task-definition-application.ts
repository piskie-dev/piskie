import type { ConfigHost } from '../../config/host/config-host.js';
import { applyConfigPatch, escapeConfigPointer } from '../../config/host/config-mutations.js';
import type { TaskDefinitionIdAllocator } from '../../core/ids/task-definition-id-allocator.js';
import { taskDefinitionIdAllocator } from '../../core/ids/task-definition-id-allocator.js';
import type { TaskDefinitionStore } from '../../core/storage/task-definition-store.js';
import type { IMGateway } from '../../im-gateway/index.js';
import type { TaskDefinition } from '../../../shared/types/index.js';
import type {
  TaskDefinitionCreateInput,
  TaskDefinitionSnapshot,
  TaskDefinitionUpdateInput,
} from '../../../shared/electron-contracts/task-definitions.js';
import { PublicOperationError } from '../public-errors.js';
import { taskDefinitionSnapshot } from './public-task-definition-view.js';

type StoredTaskDefinition = Omit<TaskDefinition, 'definitionId'>;
type WritableTaskDefinition = Omit<StoredTaskDefinition, 'createdAt'>;
type TaskDefinitionsDocument = {
  revision: number;
  definitions: Record<string, StoredTaskDefinition>;
};

export class TaskDefinitionApplication {
  constructor(
    private readonly dependencies: {
      config: ConfigHost;
      definitions: TaskDefinitionStore;
      messaging: IMGateway;
      definitionIds?: TaskDefinitionIdAllocator;
    },
  ) {}

  list(): TaskDefinitionSnapshot[] {
    return this.dependencies.definitions.list().map(taskDefinitionSnapshot);
  }

  async create(input: TaskDefinitionCreateInput): Promise<TaskDefinitionSnapshot> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.dependencies.config.show<TaskDefinitionsDocument>(
        'task-definitions',
      );
      const definitionId = await (
        this.dependencies.definitionIds ?? taskDefinitionIdAllocator
      ).allocate((candidate) => Object.hasOwn(current.definitions, candidate));
      const value = this.dependencies.config.projectWrite<{
        definitions: Record<string, WritableTaskDefinition>;
      }>('task-definitions', { definitions: { [definitionId]: input } }).definitions[
        definitionId
      ]!;

      try {
        const result = await applyConfigPatch<TaskDefinitionsDocument>(
          this.dependencies.config,
          'task-definitions',
          [{
            op: 'add',
            path: `/definitions/${escapeConfigPointer(definitionId)}`,
            value,
          }],
          current.revision,
        );
        return taskDefinitionSnapshot({
          definitionId,
          ...result.current.definitions[definitionId]!,
        });
      } catch (error) {
        if (isRevisionConflict(error)) continue;
        throw error;
      }
    }
    throw new Error('Unable to create Task Definition after concurrent configuration changes');
  }

  async update(
    definitionId: string,
    updates: TaskDefinitionUpdateInput,
  ): Promise<TaskDefinitionSnapshot> {
    const current = await this.dependencies.config.show<TaskDefinitionsDocument>(
      'task-definitions',
    );
    const existing = current.definitions[definitionId];
    if (!existing) {
      throw new PublicOperationError('not-found', 'Task Definition was not found');
    }

    const submitted: WritableTaskDefinition = {
      ...withoutCreatedAt(existing),
      ...updates,
    };
    const value = this.dependencies.config.projectWrite<{
      definitions: Record<string, WritableTaskDefinition>;
    }>('task-definitions', { definitions: { [definitionId]: submitted } }).definitions[
      definitionId
    ]!;
    const result = await applyConfigPatch<TaskDefinitionsDocument>(
      this.dependencies.config,
      'task-definitions',
      [{
        op: 'replace',
        path: `/definitions/${escapeConfigPointer(definitionId)}`,
        value,
      }],
      current.revision,
    );
    return taskDefinitionSnapshot({
      definitionId,
      ...result.current.definitions[definitionId]!,
    });
  }

  async delete(definitionId: string): Promise<{
    affectedBots: Array<{ botId: string; name: string }>;
  }> {
    if (!this.dependencies.definitions.get(definitionId)) {
      throw new PublicOperationError('not-found', 'Task Definition was not found');
    }
    const affectedBots = this.dependencies.messaging
      .getBotConfigs()
      .filter((bot) => bot.definitionId === definitionId)
      .map((bot) => ({ botId: bot.id, name: bot.name }));

    await applyConfigPatch(this.dependencies.config, 'task-definitions', [{
      op: 'remove',
      path: `/definitions/${escapeConfigPointer(definitionId)}`,
    }]);
    return { affectedBots };
  }
}

function withoutCreatedAt(definition: StoredTaskDefinition): WritableTaskDefinition {
  const { createdAt: _createdAt, ...value } = definition;
  return value;
}

function isRevisionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = Reflect.get(error, 'code');
  if (
    code === 'CONFIG_REVISION_CONFLICT'
    || code === 'CONFIG_PLAN_REVISION_CHANGED'
    || code === 'CONFIG_PLAN_BASE_REVISION_MISMATCH'
  ) return true;
  const message = Reflect.get(error, 'message');
  return typeof message === 'string' && /\brevision\b/i.test(message);
}
