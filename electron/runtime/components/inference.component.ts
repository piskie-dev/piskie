import type { SearchService } from '../../search/service.js';
import { appLog } from '@electron/observability/logging/app-log.js';
import { app, net } from 'electron';
import { DefaultAgentInferencePort } from '../../inference/application/agent-inference-port.js';
import { DefaultImageApplicationPort } from '../../inference/application/image-application-port.js';
import { InferenceRuntimeHost } from '../../inference/composition/runtime-host.js';
import {
  resolveElectronComfySocketFactory,
  resolveElectronInferenceFetch,
} from '../../inference/composition/electron-transport.js';
import { createElectronConfigDomainIntegrations } from '../../config/host/electron-integrations.js';
import type { AgentService, AgentServiceRuntimeBindings } from '../../services/agent.service.js';
import type { RuntimeComponent } from '../component-manifest.js';

export interface InferenceComponentState {
  bindings?: AgentServiceRuntimeBindings;
}

export function createInferenceComponent(options: {
  userDataDirectory: string;
  agentService: AgentService;
  search: SearchService;
  state: InferenceComponentState;
}): RuntimeComponent<AgentServiceRuntimeBindings> {
  let host: InferenceRuntimeHost | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const close = (): Promise<void> => {
    closePromise ??= (host?.close() ?? Promise.resolve()).then(() => {
      closed = true;
    });
    return closePromise;
  };

  return {
    id: 'inference',
    requirement: 'required',
    dependsOn: ['proxy-transports', 'web-search'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'inference-runtime-host',
        close,
        inspect: () => (!host || closed ? 'closed' : 'live'),
      });
      host = new InferenceRuntimeHost({
        rootDirectory: options.userDataDirectory,
        remoteCatalog: {
          autoRefresh: true,
          baseUrl: process.env.PISKIE_MODEL_CATALOG_BASE_URL ?? 'https://www.piskie.dev',
          clientVersion: app.getVersion(),
          fetch: (input, init) => net.fetch(input instanceof Request ? input : String(input), init),
          onError: (error) => appLog.warn({
            event: 'inference.catalog.update.failed',
            message: 'Model catalog update failed; retaining the current catalog',
            context: { scope: 'inference.catalog' },
            error,
          }),
        },
        configIntegrations: createElectronConfigDomainIntegrations({ publish: (config) => options.search.publish(config) }),
        openAi: { resolveFetch: resolveElectronInferenceFetch },
        anthropic: { resolveFetch: resolveElectronInferenceFetch },
        imageHttp: { resolveFetch: resolveElectronInferenceFetch },
        comfyui: {
          resolveFetch: resolveElectronInferenceFetch,
          resolveSocketFactory: resolveElectronComfySocketFactory,
        },
        onReloadError: (error) =>
          appLog.error({
            event: 'inference.config.reload.failed',
            message: 'Inference configuration reload failed',
            context: { scope: 'inference.config' },
            error: error,
          }),
      });
      await host.initialize();
      const bindings: AgentServiceRuntimeBindings = {
        userDataDirectory: options.userDataDirectory,
        inferenceHost: host,
        search: options.search,
        agentInference: new DefaultAgentInferencePort(
          host.aiGateway,
          host.control.runtime,
          host.artifacts
        ),
        imageApplication: new DefaultImageApplicationPort(
          host.imageGateway,
          host.control.runtime,
          host.artifacts
        ),
      };
      options.state.bindings = bindings;
      return bindings;
    },
    async stop() {
      await close();
      options.state.bindings = undefined;
    },
    async verifyStopped() {
      return { state: !host || closed ? 'stopped' : 'live' };
    },
  };
}
