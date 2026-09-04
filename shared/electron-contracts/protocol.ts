import type { PublicFault } from './public-fault.js';

export const ELECTRON_PROTOCOL_VERSION = 1 as const;
export const ELECTRON_CONNECT_CHANNEL = 'piskie.desktop.connect.v1' as const;

export type CapabilityId =
  | 'account'
  | 'agent-runs'
  | 'agents'
  | 'capabilities'
  | 'configuration'
  | 'desktop'
  | 'inference'
  | 'messaging'
  | 'modes'
  | 'observability'
  | 'pilot'
  | 'runtime'
  | 'task-definitions'
  | 'updates';

export interface BackendRuntimeSnapshot {
  readonly phase: 'ready' | 'stopping';
  readonly startedAt: number;
  readonly degraded: readonly {
    componentId: string;
    reason: string;
  }[];
}

export interface ConnectHello {
  readonly protocolVersion: typeof ELECTRON_PROTOCOL_VERSION;
  readonly rendererBuildId: string;
  readonly windowNonce: string;
}

export interface ConnectWelcome {
  readonly protocolVersion: typeof ELECTRON_PROTOCOL_VERSION;
  readonly generation: string;
  readonly connectionId: string;
  readonly runtime: BackendRuntimeSnapshot;
  readonly capabilities: readonly CapabilityId[];
}

export type ClientFrame =
  | {
      readonly kind: 'request';
      readonly id: string;
      readonly operation: string;
      readonly payload: unknown;
      readonly deadlineAt?: number;
    }
  | { readonly kind: 'cancel'; readonly id: string }
  | {
      readonly kind: 'subscribe';
      readonly id: string;
      readonly topic: string;
      readonly payload?: unknown;
      readonly cursor?: string;
    }
  | { readonly kind: 'unsubscribe'; readonly subscriptionId: string };

export type HostFrame =
  | { readonly kind: 'welcome'; readonly welcome: ConnectWelcome }
  | { readonly kind: 'result'; readonly id: string; readonly value: unknown }
  | { readonly kind: 'stream'; readonly id: string; readonly metadata?: unknown }
  | { readonly kind: 'fault'; readonly id: string; readonly fault: PublicFault }
  | {
      readonly kind: 'subscribed';
      readonly id: string;
      readonly subscriptionId: string;
      readonly snapshot: unknown;
      readonly cursor: string;
    }
  | {
      readonly kind: 'change';
      readonly subscriptionId: string;
      readonly sequence: number;
      readonly value: unknown;
      readonly cursor: string;
    }
  | { readonly kind: 'closed'; readonly reason: string };
