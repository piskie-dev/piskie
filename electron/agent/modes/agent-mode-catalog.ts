import type {
  AgentModeId,
  AgentRunBindings,
  AgentRunConfig,
  TaskDefinition,
} from '../../../shared/types/index.js';
import type {
  AgentModeDescriptor,
  AgentModeQuery,
  StartAgentRequest,
} from '../../../shared/electron-contracts/index.js';
import type { AgentService } from '../../services/agent.service.js';
import type { SpecRegistry } from '../specs/spec-registry.js';
import {
  createSystemChatRunConfig,
  snapshotTaskDefinition,
} from '../launch/agent-run-config-factory.js';
import type { ResolvedAgentLaunch } from '../launch/resolved-agent-launch.js';
import type { AgentModeDefinition } from './agent-mode-definition.js';

export type AgentModeCatalogErrorCode = 'invalid-input' | 'not-found' | 'conflict';

export class AgentModeCatalogError extends Error {
  constructor(
    readonly code: AgentModeCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentModeCatalogError';
  }
}

export class AgentModeCatalog {
  private readonly definitions = new Map<AgentModeId, AgentModeDefinition>();

  constructor(
    definitions: readonly AgentModeDefinition[],
    private readonly dependencies: {
      specs: SpecRegistry;
      agent: AgentService;
      resolveTaskDefinition(definitionId: string): TaskDefinition | null;
    },
  ) {
    for (const definition of definitions) {
      const { id } = definition.descriptor;
      if (!id.trim()) throw new Error('Agent mode id cannot be empty');
      if (this.definitions.has(id)) throw new Error(`Agent mode '${id}' is already registered`);
      if (!dependencies.specs.has(definition.systemChatAgentSpec)) {
        throw new Error(
          `Agent mode '${id}' references missing AgentSpec '${definition.systemChatAgentSpec}'`,
        );
      }
      this.definitions.set(id, Object.freeze({
        ...definition,
        descriptor: Object.freeze({ ...definition.descriptor }),
      }));
    }
  }

  listAvailable(query: AgentModeQuery = {}): AgentModeDescriptor[] {
    if (!query.agentSpec) {
      return [...this.definitions.values()].map(({ descriptor }) => descriptor);
    }

    const spec = this.dependencies.specs.get(query.agentSpec);
    if (!spec) {
      throw new AgentModeCatalogError('not-found', `AgentSpec '${query.agentSpec}' was not found`);
    }
    return [...this.definitions.values()]
      .filter((definition) => definition.isAvailableFor(spec))
      .map(({ descriptor }) => descriptor);
  }

  async start(request: StartAgentRequest) {
    return this.dependencies.agent.startAgent(this.resolveLaunch(request));
  }

  resolveLaunch(request: StartAgentRequest): ResolvedAgentLaunch {
    if ('definitionId' in request && request.definitionId !== undefined) {
      return this.resolveTaskDefinitionLaunch(request);
    }
    return this.resolveSystemChatLaunch(request);
  }

  setMode(agentId: string, modeId: AgentModeId): void {
    const definition = this.requireDefinition(modeId);
    const runtime = this.dependencies.agent.getAgent(agentId);
    if (!runtime) throw new AgentModeCatalogError('not-found', 'Agent was not found');
    if (!definition.isAvailableFor(runtime.spec)) {
      throw new AgentModeCatalogError(
        'conflict',
        `Agent mode '${modeId}' is not available for AgentSpec '${runtime.spec.name}'`,
      );
    }
    if (!definition.descriptor.runtimeSwitchable) {
      throw new AgentModeCatalogError('conflict', `Agent mode '${modeId}' cannot be selected at runtime`);
    }
    if (!runtime.getModule('plan')) {
      throw new AgentModeCatalogError(
        'conflict',
        `AgentSpec '${runtime.spec.name}' does not support runtime mode changes`,
      );
    }
    if (!this.dependencies.agent.setMode(agentId, modeId)) {
      throw new AgentModeCatalogError('not-found', 'Agent was not found');
    }
  }

  private resolveTaskDefinitionLaunch(
    request: Extract<StartAgentRequest, { definitionId: string }>,
  ): ResolvedAgentLaunch {
    const taskDefinition = this.dependencies.resolveTaskDefinition(request.definitionId);
    if (!taskDefinition) {
      throw new AgentModeCatalogError('not-found', 'Task Definition was not found');
    }
    const modeId = request.modeId ?? taskDefinition.defaultModeId;
    const mode = this.requireDefinition(modeId);
    const agentSpec = this.requireSpec('director');
    if (!mode.isAvailableFor(agentSpec)) {
      throw new AgentModeCatalogError(
        'conflict',
        `Agent mode '${modeId}' is not available for AgentSpec '${agentSpec.name}'`,
      );
    }
    return {
      runConfig: applyRequestOverrides(snapshotTaskDefinition(taskDefinition), request),
      agentSpec,
      initialModeId: modeId,
      initialApprovalMode: request.approvalMode ?? taskDefinition.defaultApprovalMode,
      launchOptions: request.launchOptions,
    };
  }

  private resolveSystemChatLaunch(
    request: Extract<StartAgentRequest, { input: string }>,
  ): ResolvedAgentLaunch {
    const input = request.input.trim();
    if (!input) throw new AgentModeCatalogError('invalid-input', 'Agent input cannot be empty');
    const mode = this.requireDefinition(request.modeId);
    const agentSpec = this.requireSpec(mode.systemChatAgentSpec);
    if (!mode.isAvailableFor(agentSpec)) {
      throw new AgentModeCatalogError(
        'conflict',
        `Agent mode '${request.modeId}' is not available for AgentSpec '${agentSpec.name}'`,
      );
    }
    return {
      runConfig: applyRequestOverrides(
        createSystemChatRunConfig(input, request.workspace),
        request,
      ),
      agentSpec,
      initialModeId: request.modeId,
      initialApprovalMode: request.approvalMode ?? 'confirm',
      launchOptions: request.launchOptions,
    };
  }

  private requireDefinition(modeId: AgentModeId): AgentModeDefinition {
    const definition = this.definitions.get(modeId);
    if (!definition) {
      throw new AgentModeCatalogError('invalid-input', `Agent mode '${modeId}' is not registered`);
    }
    return definition;
  }

  private requireSpec(name: string) {
    const spec = this.dependencies.specs.get(name);
    if (!spec) throw new AgentModeCatalogError('not-found', `AgentSpec '${name}' was not found`);
    return spec;
  }
}

function applyRequestOverrides(
  runConfig: AgentRunConfig,
  request: Pick<StartAgentRequest, 'workspace' | 'environmentIds'>,
): AgentRunConfig {
  return {
    ...runConfig,
    ...(request.workspace !== undefined ? { workspace: request.workspace } : {}),
    ...(request.environmentIds !== undefined
      ? { bindings: bindingsFromEnvironmentIds(request.environmentIds) }
      : {}),
  };
}

function bindingsFromEnvironmentIds(environmentIds: string[]): AgentRunBindings | undefined {
  const boundEnvironmentIds = [...new Set(environmentIds.filter(Boolean))];
  return boundEnvironmentIds.length > 0
    ? { type: 'standard', boundEnvironmentIds }
    : undefined;
}
