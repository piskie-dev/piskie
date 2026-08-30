import type { CapabilityId } from '../../shared/electron-contracts/protocol.js';
import type { z } from 'zod';

export interface ControllerContext {
  readonly generation: string;
  readonly connectionId: string;
  readonly windowId: number;
  readonly signal: AbortSignal;
}

export interface StreamTransfer {
  readonly kind: 'stream-transfer';
  readonly port: TransferPort;
  readonly metadata?: unknown;
}

export interface TransferPort {
  close(): void;
  start?(): void;
  on?(event: 'close', listener: () => void): unknown;
}

export interface OperationDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly capability: CapabilityId;
  readonly input: z.ZodType<Input>;
  readonly allowDuringStopping?: boolean;
  execute(context: ControllerContext, input: Input): Promise<Output> | Output;
}

export interface TopicOpenResult<Snapshot = unknown> {
  readonly snapshot: Snapshot;
  readonly cursor?: string;
  readonly dispose: () => void | Promise<void>;
}

export interface TopicDefinition<Input = unknown, Snapshot = unknown, Change = unknown> {
  readonly id: string;
  readonly capability: CapabilityId;
  readonly input: z.ZodType<Input>;
  open(
    context: ControllerContext,
    input: Input,
    emit: (change: Change) => void,
  ): Promise<TopicOpenResult<Snapshot>> | TopicOpenResult<Snapshot>;
}

export interface ControllerCatalog {
  readonly operations: ReadonlyMap<string, OperationDefinition>;
  readonly topics: ReadonlyMap<string, TopicDefinition>;
  readonly capabilities: readonly CapabilityId[];
}

export function createControllerCatalog(input: {
  operations: readonly OperationDefinition[];
  topics?: readonly TopicDefinition[];
}): ControllerCatalog {
  const operations = uniqueById(input.operations, 'operation');
  const topics = uniqueById(input.topics ?? [], 'topic');
  const capabilities = [...new Set([
    ...input.operations.map(({ capability }) => capability),
    ...(input.topics ?? []).map(({ capability }) => capability),
  ])].sort();

  return Object.freeze({
    operations,
    topics,
    capabilities: Object.freeze(capabilities),
  });
}

export function streamTransfer(port: TransferPort, metadata?: unknown): StreamTransfer {
  return Object.freeze({ kind: 'stream-transfer', port, metadata });
}

export function isStreamTransfer(value: unknown): value is StreamTransfer {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'stream-transfer'
    && typeof (value as { port?: { close?: unknown } }).port?.close === 'function',
  );
}

function uniqueById<T extends { id: string }>(
  definitions: readonly T[],
  kind: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const definition of definitions) {
    if (!definition.id.trim()) throw new Error(`${kind} id must not be empty`);
    if (result.has(definition.id)) throw new Error(`Duplicate ${kind} id: ${definition.id}`);
    result.set(definition.id, Object.freeze(definition));
  }
  return result;
}
