import { AIErrorType } from '../../../shared/constants/index.js';
import type { ModelTarget } from './contracts.js';

export type GatewayErrorSource = 'provider' | 'transport' | 'local' | 'timeout' | 'cancelled';
export type GatewayKind = 'ai' | 'image';

export interface UpstreamErrorDetails {
  status?: number;
  code?: string;
  type?: string;
  param?: string;
  message: string;
  requestId?: string;
  body?: unknown;
}

export interface GatewayCallErrorData {
  source: GatewayErrorSource;
  gateway: GatewayKind;
  providerId: string;
  modelId: string;
  driverId: string;
  stage: string;
  attempt: number;
  traceId: string;
  message: string;
  upstream?: UpstreamErrorDetails;
  localCode?: string;
}

export class GatewayCallError extends Error implements GatewayCallErrorData {
  readonly source: GatewayErrorSource;
  readonly gateway: GatewayKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly driverId: string;
  readonly stage: string;
  readonly attempt: number;
  readonly traceId: string;
  readonly upstream?: UpstreamErrorDetails;
  readonly localCode?: string;

  constructor(data: GatewayCallErrorData, options?: ErrorOptions) {
    super(data.message, options);
    this.name = 'GatewayCallError';
    this.source = data.source;
    this.gateway = data.gateway;
    this.providerId = data.providerId;
    this.modelId = data.modelId;
    this.driverId = data.driverId;
    this.stage = data.stage;
    this.attempt = data.attempt;
    this.traceId = data.traceId;
    this.upstream = data.upstream;
    this.localCode = data.localCode;
  }

  toJSON(): GatewayCallErrorData {
    return {
      source: this.source,
      gateway: this.gateway,
      providerId: this.providerId,
      modelId: this.modelId,
      driverId: this.driverId,
      stage: this.stage,
      attempt: this.attempt,
      traceId: this.traceId,
      message: this.message,
      ...(this.upstream && { upstream: this.upstream }),
      ...(this.localCode && { localCode: this.localCode }),
    };
  }
}

export interface LocalErrorInput {
  gateway: GatewayKind;
  target: ModelTarget;
  driverId: string;
  stage: string;
  attempt: number;
  traceId: string;
  localCode: string;
  message: string;
  cause?: unknown;
}

export function localCallError(input: LocalErrorInput): GatewayCallError {
  return new GatewayCallError(
    {
      source: 'local',
      gateway: input.gateway,
      providerId: input.target.providerId,
      modelId: input.target.modelId,
      driverId: input.driverId,
      stage: input.stage,
      attempt: input.attempt,
      traceId: input.traceId,
      message: input.message,
      localCode: input.localCode,
    },
    { cause: input.cause },
  );
}

export function isGatewayCallError(value: unknown): value is GatewayCallError {
  return value instanceof GatewayCallError;
}


const CONTEXT_OVERFLOW_CODE = 'context_length_exceeded';

function isContextOverflow(error: GatewayCallError): boolean {
  return error.source === 'provider' && error.upstream?.code === CONTEXT_OVERFLOW_CODE;
}

/**
 * `GatewayCallError` 的唯一分类出口：新增一档只改这一处，不存在第二份会漂移的实现。
 */
export function classifyGatewayCallError(error: GatewayCallError): AIErrorType {
  if (error.source === 'timeout') return AIErrorType.TIMEOUT;
  if (error.source === 'transport') return AIErrorType.NETWORK;
  if (isContextOverflow(error)) return AIErrorType.CONTEXT_OVERFLOW;
  if (error.upstream?.status === 429) return AIErrorType.RATE_LIMIT;
  if (error.localCode === 'AI_EMPTY_COMPLETION') return AIErrorType.EMPTY_COMPLETED_RESPONSE;
  if (error.source === 'provider' || error.source === 'local') return AIErrorType.API_ERROR;
  return AIErrorType.UNKNOWN;
}
