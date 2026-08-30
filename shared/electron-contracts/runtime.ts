import type { BackendRuntimeSnapshot } from './protocol.js';

export const RUNTIME_OPERATIONS = Object.freeze({
  status: 'runtime.status',
} as const);

export interface RuntimeClient {
  readonly host: 'electron';
  readonly protocolVersion: 1;
  readonly version: string;
  status(): Promise<BackendRuntimeSnapshot>;
}
