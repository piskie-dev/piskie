import type { ArtifactReader, ArtifactStore } from '../execution/artifact-port.js';
import type { ComfyWorkflowAssetStore } from '../control/workflow-assets.js';
import {
  createAnthropicMessagesDriver,
  type AnthropicMessagesDriverDependencies,
} from '../drivers/anthropic-messages/driver.js';
import { createBaiduImageDriver } from '../drivers/baidu-image/driver.js';
import {
  createComfyWorkflowDriver,
  type ComfyWorkflowDriverDependencies,
} from '../drivers/comfyui-workflow/driver.js';
import { createDashScopeImageDriver } from '../drivers/dashscope-image/driver.js';
import { createGeminiImageDriver } from '../drivers/gemini-image/driver.js';
import {
  createOpenAiDriver,
  type OpenAiDriverDependencies,
} from '../drivers/openai/driver.js';
import { createOpenRouterImageDriver } from '../drivers/openrouter-image/driver.js';
import { DriverRegistry } from '../drivers/registry.js';

export interface BuiltInInferenceDriverOptions {
  artifacts: ArtifactReader & ArtifactStore;
  workflows: ComfyWorkflowAssetStore;
  openAi?: Omit<OpenAiDriverDependencies, 'artifacts' | 'imageArtifacts'>;
  anthropic?: Omit<AnthropicMessagesDriverDependencies, 'artifacts'>;
  comfyui?: Omit<ComfyWorkflowDriverDependencies, 'workflows' | 'artifacts'>;
  imageHttp?: {
    fetch?: typeof globalThis.fetch;
    resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  };
  now?: () => Date;
}

export function registerBuiltInInferenceDrivers(
  registry: DriverRegistry,
  options: BuiltInInferenceDriverOptions,
): DriverRegistry {
  const now = options.now ? { now: options.now } : {};
  registry.register(createOpenAiDriver({
    ...options.openAi,
    artifacts: options.artifacts,
    imageArtifacts: options.artifacts,
    ...now,
  }));
  registry.register(createAnthropicMessagesDriver({
    ...options.anthropic,
    artifacts: options.artifacts,
    ...now,
  }));
  registry.register(createComfyWorkflowDriver({
    ...options.comfyui,
    workflows: options.workflows,
    artifacts: options.artifacts,
    ...now,
  }));

  const imageHttp = {
    ...options.imageHttp,
    artifacts: options.artifacts,
    imageArtifacts: options.artifacts,
    ...now,
  };
  registry.register(createOpenRouterImageDriver(imageHttp));
  registry.register(createGeminiImageDriver(imageHttp));
  registry.register(createDashScopeImageDriver(imageHttp));
  registry.register(createBaiduImageDriver(imageHttp));
  return registry;
}

export function createBuiltInInferenceDriverRegistry(
  options: BuiltInInferenceDriverOptions,
): DriverRegistry {
  return registerBuiltInInferenceDrivers(new DriverRegistry(), options);
}
