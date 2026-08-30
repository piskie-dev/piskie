import { useContext } from 'react';
import { useStore } from 'zustand';

import type { AgentControlSnapshot } from '@shared/electron-contracts/agent-runs';
import type { AgentControlStoreSnapshot } from '../domains/agent-control/agent-control-store';
import type {
  AgentRunListSnapshot,
  AgentRunPreviewSnapshot,
} from '../domains/agent-runs/agent-run-repository';
import type { TaskDefinitionRepositorySnapshot } from '../domains/task-definitions/task-definition-repository';
import type { ContextInspectorResourceSnapshot } from '../features/context-inspector/context-inspector-resource';
import { RendererRuntimeContext } from './renderer-runtime-context';
import type { RendererRuntime } from './renderer-runtime';

export function useRendererRuntime(): RendererRuntime {
  const runtime = useContext(RendererRuntimeContext);
  if (!runtime) throw new Error('RendererRuntimeProvider is missing');
  return runtime;
}

export function useAgentControl<T>(
  selector: (snapshot: AgentControlStoreSnapshot) => T,
): T {
  const runtime = useRendererRuntime();
  return useStore(runtime.agentControl.state, selector);
}

export function useContextInspectorResource<T>(
  selector: (snapshot: ContextInspectorResourceSnapshot) => T,
): T {
  const runtime = useRendererRuntime();
  return useStore(runtime.contextInspector.state, selector);
}

export function useTaskDefinitionRepository<T>(
  selector: (snapshot: TaskDefinitionRepositorySnapshot) => T,
): T {
  const runtime = useRendererRuntime();
  return useStore(runtime.taskDefinitions.state, selector);
}

export function useAgentRunList<T>(selector: (snapshot: AgentRunListSnapshot) => T): T {
  const runtime = useRendererRuntime();
  return useStore(runtime.agentRuns.listState, selector);
}

export function useAgentRunPreview<T>(
  selector: (snapshot: AgentRunPreviewSnapshot) => T,
): T {
  const runtime = useRendererRuntime();
  return useStore(runtime.agentRuns.previewState, selector);
}

export function useDisplayAgentState(
  agentId: string | null | undefined,
): AgentControlSnapshot | undefined {
  const active = useAgentControl((snapshot) => (
    agentId ? snapshot.agentsById[agentId] : undefined
  ));
  const preview = useAgentRunPreview((snapshot) => (
    agentId && snapshot.agentId === agentId ? snapshot.state ?? undefined : undefined
  ));
  return active ?? preview;
}
