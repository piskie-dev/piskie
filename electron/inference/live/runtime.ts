import os from 'node:os';
import path from 'node:path';
import type { ModelTarget } from '../execution/contracts.js';
import { createNodeInferenceTransports } from '../composition/node-transport.js';
import { InferenceRuntimeHost } from '../composition/runtime-host.js';

export function liveConfigRoot(): string {
  return path.resolve(process.env.PISKIE_CONFIG_ROOT ?? path.join(os.homedir(), '.piskie'));
}

export function createLiveRuntime(options: {
  comfyFetch?: typeof globalThis.fetch;
  runtimeDirectory: string;
}): InferenceRuntimeHost {
  const rootDirectory = liveConfigRoot();
  const transports = createNodeInferenceTransports(rootDirectory);
  return new InferenceRuntimeHost({
    rootDirectory,
    artifactDirectory: path.join(options.runtimeDirectory, 'artifacts'),
    imageJobDirectory: path.join(options.runtimeDirectory, 'image-jobs'),
    runtimeReceiptFile: path.join(options.runtimeDirectory, 'inference-runtime.json'),
    publisher: 'test',
    openAi: { resolveFetch: transports.resolveFetch },
    anthropic: { resolveFetch: transports.resolveFetch },
    imageHttp: { resolveFetch: transports.resolveFetch },
    comfyui: {
      ...(options.comfyFetch && { fetch: options.comfyFetch }),
      resolveFetch: transports.resolveFetch,
      resolveSocketFactory: transports.resolveSocketFactory,
    },
    onClose: transports.close,
  });
}

export function parseLiveTargets(source: string, variable: string): ModelTarget[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${variable} must be valid JSON`, { cause });
  }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.some((value) => !isTarget(value))) {
    throw new Error(`${variable} must be a target or a non-empty target array`);
  }
  return values;
}

function isTarget(value: unknown): value is ModelTarget {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).providerId === 'string'
    && typeof (value as Record<string, unknown>).modelId === 'string';
}
