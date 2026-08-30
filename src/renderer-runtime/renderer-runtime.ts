import type { PiskieDesktopApi } from '@shared/electron-contracts/api';
import type { AgentLiveContentDelta } from '@shared/electron-contracts/agents';
import type { AgentControlChangedEvent } from '@shared/electron-contracts/agent-runs';
import {
  createAgentControlStore,
  type AgentControlStore,
} from '../domains/agent-control/agent-control-store';
import {
  createAgentCommands,
  type AgentCommands,
} from '../domains/agent-control/agent-commands';
import {
  createContextInspectorResource,
  type ContextInspectorResource,
} from '../features/context-inspector/context-inspector-resource';
import {
  createTranscriptStore,
  type TranscriptStore,
} from '../domains/transcript/transcript-store';
import {
  createScreenFeedRegistry,
  type ScreenFeedRegistry,
} from '../domains/screen-feed/screen-feed-registry';
import {
  createTaskDefinitionRepository,
  type TaskDefinitionRepository,
} from '../domains/task-definitions/task-definition-repository';
import {
  createAgentRunRepository,
  type AgentRunRepository,
} from '../domains/agent-runs/agent-run-repository';

export type RendererRuntimePhase =
  | 'new'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface RendererRuntimeServices {
  startSubscriptions(
    register: (dispose: () => void) => void,
    domains: Pick<RendererRuntime, 'taskDefinitions'>,
  ): void;
  bootstrap(): Promise<void>;
  stop(): void | Promise<void>;
}

export interface RendererRuntime {
  readonly agentControl: AgentControlStore;
  readonly agentCommands: AgentCommands;
  readonly contextInspector: ContextInspectorResource;
  readonly transcript: TranscriptStore;
  readonly screenFeeds: ScreenFeedRegistry;
  readonly taskDefinitions: TaskDefinitionRepository;
  readonly agentRuns: AgentRunRepository;
  phase(): RendererRuntimePhase;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createRuntime(
  api: PiskieDesktopApi,
  services: RendererRuntimeServices,
  resources: {
    readonly screenFeeds?: ScreenFeedRegistry;
    readonly taskDefinitions?: TaskDefinitionRepository;
    readonly agentRuns?: AgentRunRepository;
  } = {},
): RendererRuntime {
  const agentControl = createAgentControlStore();
  const agentRuns = resources.agentRuns ?? createAgentRunRepository(api.agentRuns);
  const agentCommands = createAgentCommands(api.agents, agentControl, agentRuns);
  const contextInspector = createContextInspectorResource(api.agents);
  const transcript = createTranscriptStore(api.agents);
  const screenFeeds = resources.screenFeeds ?? createScreenFeedRegistry();
  const taskDefinitions = resources.taskDefinitions
    ?? createTaskDefinitionRepository(api.taskDefinitions);
  let currentPhase: RendererRuntimePhase = 'new';
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let disposers: Array<() => void> = [];
  let controlBuffer: AgentControlChangedEvent[] | null = null;
  let liveBuffer: AgentLiveContentDelta[] | null = null;

  const applyControl = (event: AgentControlChangedEvent) => {
    agentControl.apply(event);
    if (event.state) agentRuns.clearPreview(event.agentId);
    transcript.syncControl(agentControl.state.getState().targetsById);
  };

  const disposeSubscriptions = () => {
    const active = disposers;
    disposers = [];
    for (let index = active.length - 1; index >= 0; index -= 1) {
      try {
        active[index]?.();
      } catch (error) {
        console.error('Failed to dispose renderer subscription:', error);
      }
    }
  };

  const runtime: RendererRuntime = {
    agentControl,
    agentCommands,
    contextInspector,
    transcript,
    screenFeeds,
    taskDefinitions,
    agentRuns,
    phase: () => currentPhase,
    start() {
      if (currentPhase === 'ready') return Promise.resolve();
      if (startPromise) return startPromise;
      if (currentPhase !== 'new') {
        return Promise.reject(new Error(`Renderer runtime cannot start from ${currentPhase}`));
      }

      currentPhase = 'starting';
      controlBuffer = [];
      liveBuffer = [];
      startPromise = (async () => {
        try {
          disposers.push(api.agents.observeState((event) => {
            if (controlBuffer) controlBuffer.push(event);
            else applyControl(event);
          }));
          disposers.push(api.agents.observeConversation((event) => {
            transcript.applyConversation(event);
          }));
          disposers.push(api.agents.observeLiveContent((event) => {
            if (liveBuffer) liveBuffer.push(event);
            else transcript.enqueueLive(event);
          }));
          services.startSubscriptions(
            (dispose) => disposers.push(dispose),
            { taskDefinitions },
          );

          await api.runtime.status();
          const initialStates = await api.agents.listStates();
          agentControl.replace(initialStates);
          transcript.syncControl(agentControl.state.getState().targetsById);

          const pendingControl = controlBuffer;
          controlBuffer = null;
          for (const event of pendingControl) applyControl(event);

          const pendingLive = liveBuffer;
          liveBuffer = null;
          for (const event of pendingLive) transcript.enqueueLive(event);

          await services.bootstrap();
          currentPhase = 'ready';
        } catch (error) {
          controlBuffer = null;
          liveBuffer = null;
          disposeSubscriptions();
          contextInspector.close();
          transcript.close();
          taskDefinitions.close();
          agentRuns.close();
          try {
            await screenFeeds.close();
          } catch (closeError) {
            console.error('Failed to roll back screen feeds:', closeError);
          }
          try {
            await services.stop();
          } catch (stopError) {
            console.error('Failed to roll back renderer services:', stopError);
          }
          agentControl.clear();
          currentPhase = 'failed';
          throw error;
        } finally {
          startPromise = null;
        }
      })();
      return startPromise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (currentPhase === 'stopped') return;
        if (startPromise) {
          try {
            await startPromise;
          } catch {
            return;
          }
        }
        if (currentPhase === 'failed') return;

        currentPhase = 'stopping';
        controlBuffer = null;
        liveBuffer = null;
        disposeSubscriptions();
        contextInspector.close();
        transcript.close();
        taskDefinitions.close();
        agentRuns.close();
        try {
          await screenFeeds.close();
        } finally {
          try {
            await services.stop();
          } finally {
            agentControl.clear();
            currentPhase = 'stopped';
          }
        }
      })();
      return stopPromise;
    },
  };
  return runtime;
}
