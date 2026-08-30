import { z } from 'zod';
import { RUNTIME_OPERATIONS } from '../../../shared/electron-contracts/runtime.js';
import type { BackendRuntimeSnapshot } from '../../../shared/electron-contracts/protocol.js';
import type { BackendSnapshot } from '../../runtime/lifecycle/runtime-state.js';
import type { OperationDefinition } from '../catalog.js';
import { args } from '../validation.js';

export function createRuntimeController(
  snapshot: () => BackendSnapshot,
): readonly OperationDefinition[] {
  return Object.freeze([{
    id: RUNTIME_OPERATIONS.status,
    capability: 'runtime',
    input: args([]) as z.ZodType<unknown[]>,
    allowDuringStopping: true,
    execute: () => backendRuntimeSnapshot(snapshot()),
  }]);
}

export function backendRuntimeSnapshot(snapshot: BackendSnapshot): BackendRuntimeSnapshot {
  return Object.freeze({
    phase: snapshot.phase === 'ready' ? 'ready' : 'stopping',
    startedAt: snapshot.startedAt ?? Date.now(),
    degraded: Object.freeze(snapshot.degradedCapabilities.map((item) => Object.freeze({
      componentId: item.componentId,
      reason: item.reason.message,
    }))),
  });
}
