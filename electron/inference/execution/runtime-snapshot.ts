import type { AiAttemptEvent, AiRequest, GenerationOptions } from '../ai/contracts.js';
import type { ModelDefinition } from '../catalog/contracts.js';
import type { ReasoningProfile, ReasoningSelection } from '../../../shared/types/reasoning.js';
import type { AttemptContext, ModelTarget } from './contracts.js';
import type { CompiledImageTarget } from '../image/driver-port.js';

export interface AiExecutionPolicy {
  maxAttempts: number;
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
  retryBaseDelayMs: number;
}

export interface ImageExecutionPolicy {
  maxSubmitAttempts: number;
  submitTimeoutMs: number;
  operationTimeoutMs: number;
  allowResubmitAfterAccepted: false;
}

export interface CompiledAiTarget {
  generationDefaults?: Readonly<GenerationOptions>;
  openAttempt(request: AiRequest, context: AttemptContext): AsyncIterable<AiAttemptEvent>;
  /**
   * 请求前向 provider 问这份 payload 有多少输入 token。
   *
   * **方法缺席即能力缺席**：OpenAI 协议没有 count 端点，它的 driver 就不实现这个方法。
   * 调用方据此走「发出去让服务端判」，而不是退回本地估算——本地没有分词器，
   * 任何本地算出的数都是猜的。全仓没有一处 `if (provider === ...)` 来表达这件事。
   */
  countInputTokens?(request: AiRequest, signal?: AbortSignal): Promise<number>;
}

export interface CompiledTarget {
  ref: ModelTarget;
  driverId: string;
  upstreamModel: string;
  catalogId: string;
  configRevision: number;
  modelDefinition?: ModelDefinition;
  reasoning?: {
    profile: ReasoningProfile;
    modelDefault?: ReasoningSelection;
  };
  ai?: CompiledAiTarget;
  image?: CompiledImageTarget;
}

export interface InferenceRuntimeSnapshot {
  configRevision: number;
  catalogVersion: string;
  catalogModels?: ReadonlyMap<string, ModelDefinition>;
  targets: ReadonlyMap<string, ReadonlyMap<string, CompiledTarget>>;
  policies: {
    ai: AiExecutionPolicy;
    image: ImageExecutionPolicy;
  };
  createdAt: string;
}

export function findCompiledTarget(
  snapshot: InferenceRuntimeSnapshot,
  ref: ModelTarget,
): CompiledTarget | undefined {
  return snapshot.targets.get(ref.providerId)?.get(ref.modelId);
}

export class RuntimeSnapshotStore {
  private currentSnapshot: InferenceRuntimeSnapshot | undefined;
  private readonly snapshotsByRevision = new Map<number, InferenceRuntimeSnapshot>();

  capture(): InferenceRuntimeSnapshot | undefined {
    return this.currentSnapshot;
  }

  captureRevision(revision: number): InferenceRuntimeSnapshot | undefined {
    return this.snapshotsByRevision.get(revision);
  }

  publish(snapshot: InferenceRuntimeSnapshot): void {
    this.currentSnapshot = snapshot;
    this.snapshotsByRevision.set(snapshot.configRevision, snapshot);
  }

  retainHistorical(snapshot: InferenceRuntimeSnapshot): void {
    this.snapshotsByRevision.set(snapshot.configRevision, snapshot);
  }
}
