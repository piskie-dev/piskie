import { createUuid } from '@shared/utils/identifiers.js';
import { DefaultAiGateway } from '../ai/public-gateway.js';
import { reasoningRequest, resolveEffectiveReasoning } from '../ai/reasoning-policy.js';
import type { AiRequest } from '../ai/contracts.js';
import type { ProbeLevel, ProbeReceipt } from '../drivers/contracts.js';
import type { DriverRegistry } from '../drivers/registry.js';
import { isGatewayCallError, localCallError } from '../execution/call-error.js';
import type { ModelTarget, RunContext } from '../execution/contracts.js';
import {
  RuntimeSnapshotStore,
  type CompiledTarget,
  type InferenceRuntimeSnapshot,
} from '../execution/runtime-snapshot.js';
import type { ImageRequest } from '../image/contracts.js';
import type { ImageJobJournal } from '../image/job-journal.js';
import { DefaultImageGateway } from '../image/public-gateway.js';
import type { InferenceConfig } from './config-schema.js';

export interface InferenceProbeServiceOptions {
  drivers: DriverRegistry;
  journal: ImageJobJournal;
  now?: () => Date;
  aiSmokeTimeoutMs?: number;
}

export class InferenceProbeService {
  private readonly now: () => Date;
  private readonly aiSmokeTimeoutMs: number;

  constructor(private readonly options: InferenceProbeServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.aiSmokeTimeoutMs = options.aiSmokeTimeoutMs ?? 60_000;
  }

  async run(
    config: InferenceConfig,
    snapshot: InferenceRuntimeSnapshot,
    level: ProbeLevel,
    target: Partial<ModelTarget> | undefined,
    signal: AbortSignal,
  ): Promise<readonly ProbeReceipt[]> {
    return level === 'connectivity'
      ? this.connectivity(config, snapshot, target, signal)
      : this.smoke(snapshot, target, signal);
  }

  private async connectivity(
    config: InferenceConfig,
    snapshot: InferenceRuntimeSnapshot,
    target: Partial<ModelTarget> | undefined,
    signal: AbortSignal,
  ): Promise<readonly ProbeReceipt[]> {
    const receipts: ProbeReceipt[] = [];
    for (const [providerId, provider] of sortedEntries(config.providers)) {
      if (!provider.enabled || (target?.providerId && target.providerId !== providerId)) continue;
      const availableModels = snapshot.targets.get(providerId);
      if (!availableModels || availableModels.size === 0) continue;
      if (target?.modelId && !availableModels.has(target.modelId)) continue;
      const driver = this.options.drivers.get(provider.driver);
      if (!driver) continue;
      receipts.push(await driver.probeConnectivity({ providerId, provider, signal }));
    }
    return receipts;
  }

  private async smoke(
    snapshot: InferenceRuntimeSnapshot,
    target: Partial<ModelTarget> | undefined,
    signal: AbortSignal,
  ): Promise<readonly ProbeReceipt[]> {
    const probeSnapshot = singleAttemptSnapshot(snapshot);
    const runtime = new RuntimeSnapshotStore();
    runtime.publish(probeSnapshot);
    const aiGateway = new DefaultAiGateway(runtime);
    const imageGateway = new DefaultImageGateway(runtime, this.options.journal);
    const receipts: ProbeReceipt[] = [];

    for (const [providerId, models] of sortedEntries(probeSnapshot.targets)) {
      if (target?.providerId && target.providerId !== providerId) continue;
      for (const [modelId, compiled] of sortedEntries(models)) {
        if (target?.modelId && target.modelId !== modelId) continue;
        receipts.push(await this.smokeTarget(compiled, aiGateway, imageGateway, signal));
      }
    }
    return receipts;
  }

  private async smokeTarget(
    target: CompiledTarget,
    aiGateway: DefaultAiGateway,
    imageGateway: DefaultImageGateway,
    signal: AbortSignal,
  ): Promise<ProbeReceipt> {
    const startedAt = this.now().toISOString();
    const probeId = `probe:${target.ref.providerId}:${target.ref.modelId}:${createUuid()}`;
    const context: RunContext = {
      runId: probeId,
      traceId: probeId,
      signal,
      ...(target.ai && { deadlineAt: Date.now() + this.aiSmokeTimeoutMs }),
    };

    try {
      let artifacts: ProbeReceipt['artifacts'];
      if (target.ai) {
        await aiGateway.complete(aiSmokeRequest(target), context);
      } else if (target.image) {
        const result = await imageGateway.complete(imageSmokeRequest(target.ref), context);
        artifacts = result.artifacts;
      } else {
        throw localCallError({
          gateway: target.modelDefinition?.kind ?? 'ai',
          target: target.ref,
          driverId: target.driverId,
          stage: 'binding',
          attempt: 0,
          traceId: probeId,
          localCode: 'PROBE_TARGET_NOT_COMPILED',
          message: `Target ${target.ref.providerId}/${target.ref.modelId} has no executable gateway binding`,
        });
      }
      return {
        driverId: target.driverId,
        providerId: target.ref.providerId,
        modelId: target.ref.modelId,
        level: 'smoke',
        success: true,
        startedAt,
        completedAt: this.now().toISOString(),
        ...(artifacts && { artifacts }),
      };
    } catch (cause) {
      const error = isGatewayCallError(cause)
        ? cause
        : localCallError({
          gateway: target.modelDefinition?.kind ?? 'ai',
          target: target.ref,
          driverId: target.driverId,
          stage: 'probe',
          attempt: 0,
          traceId: probeId,
          localCode: 'MODEL_SMOKE_PROBE_FAILED',
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      return {
        driverId: target.driverId,
        providerId: target.ref.providerId,
        modelId: target.ref.modelId,
        level: 'smoke',
        success: false,
        startedAt,
        completedAt: this.now().toISOString(),
        ...(error.upstream?.status !== undefined && { status: error.upstream.status }),
        ...(error.upstream?.requestId && { requestId: error.upstream.requestId }),
        error: error.toJSON(),
      };
    }
  }
}

function aiSmokeRequest(target: CompiledTarget): AiRequest {
  const effectiveReasoning = resolveEffectiveReasoning({
    profile: target.reasoning?.profile,
    modelDefault: target.reasoning?.modelDefault,
  });
  const reasoning = reasoningRequest(effectiveReasoning.selection);
  return {
    model: target.ref,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    generation: {
      maxOutputTokens: 16,
      ...(reasoning && { reasoning }),
    },
  };
}

function imageSmokeRequest(target: ModelTarget): ImageRequest {
  return {
    model: target,
    operation: {
      kind: 'generate',
      prompt: 'A cute chibi orange robot mascot head with soft rounded shapes, oversized expressive cyan eyes, and a friendly smile, centered on a soft teal background, polished 3D game icon, square composition, no text, no border, not scary.',
      count: 1,
    },
  };
}

function singleAttemptSnapshot(snapshot: InferenceRuntimeSnapshot): InferenceRuntimeSnapshot {
  return {
    ...snapshot,
    policies: {
      ai: { ...snapshot.policies.ai, maxAttempts: 1 },
      image: { ...snapshot.policies.image, maxSubmitAttempts: 1 },
    },
  };
}

function sortedEntries<T>(record: Readonly<Record<string, T>> | ReadonlyMap<string, T>): [string, T][] {
  const entries = record instanceof Map ? [...record.entries()] : Object.entries(record);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}
