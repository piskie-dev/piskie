import type { PresentedScreenPointer } from '@shared/screen-pointer';
import type { RemoteInputEvent, ScreenPageIdentity, ScreenPointer, ScreenFrameMapping } from '@shared/types/stream';

export interface ScreenViewportFrame {
  readonly page: ScreenPageIdentity | null;
  readonly width: number;
  readonly height: number;
  readonly mapping?: ScreenFrameMapping;
  readonly timestamp?: number;
  readonly seq?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
}

export interface ViewportDemand {
  readonly visible: boolean;
  readonly fps: number;
  readonly quality?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

export type ScreenCaptureOptions = Pick<
  ViewportDemand,
  'quality' | 'maxWidth' | 'maxHeight'
>;

export interface AggregateScreenDemand {
  readonly fps: number;
  readonly quality?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

export type ScreenFeedFailureCode =
  | 'offscreen-unavailable'
  | 'canvas-transfer-failed'
  | 'offscreen-context-unavailable'
  | 'worker-protocol-invalid'
  | 'worker-crashed'
  | 'port-request-failed'
  | 'port-request-timeout'
  | 'port-response-missing'
  | 'target-not-ready'
  | 'caster-failed'
  | 'stream-closed'
  | 'decode-failed'
  | 'decode-stalled';

export interface ScreenFeedFailure {
  readonly code: ScreenFeedFailureCode;
  readonly retryable: boolean;
  readonly detail?: string;
}

export interface ScreenFeedStats {
  readonly receivedFrames: number;
  readonly decodedFrames: number;
  readonly decodeFailures: number;
  readonly sequenceGaps: number;
  readonly decodedFps: number;
  readonly decodeMs: number;
}

export interface ScreenViewportStats {
  readonly leaseId: string;
  readonly visible: boolean;
  readonly drawnFrames: number;
}

export type ScreenWorkerIncomingMessage =
  | {
      readonly type: 'init-feed';
      readonly epoch: number;
      readonly streamPort: MessagePort;
      readonly demand: AggregateScreenDemand;
    }
  | {
      readonly type: 'attach-viewport';
      readonly epoch: number;
      readonly leaseId: string;
      readonly canvas: OffscreenCanvas;
      readonly visible: boolean;
    }
  | { readonly type: 'detach-viewport'; readonly epoch: number; readonly leaseId: string }
  | { readonly type: 'disconnect-feed'; readonly epoch: number }
  | {
      readonly type: 'update-demand';
      readonly epoch: number;
      readonly demand: AggregateScreenDemand;
      readonly viewports: readonly { readonly leaseId: string; readonly visible: boolean }[];
    }
  | {
      readonly type: 'input';
      readonly epoch: number;
      readonly leaseId: string;
      readonly event: RemoteInputEvent;
    }
  | { readonly type: 'pointer-presented'; readonly epoch: number; readonly leaseId: string; readonly page: ScreenPageIdentity; readonly seq: number; readonly pressSeq?: number; readonly targetSeq?: number; readonly activitySeq?: number; readonly at: number }
  | { readonly type: 'pointer-cleared'; readonly epoch: number; readonly leaseId: string; readonly clearId: number }
  | { readonly type: 'close'; readonly epoch: number };

export type ScreenWorkerOutgoingMessage =
  | { readonly type: 'feed-ready'; readonly epoch: number }
  | { readonly type: 'screen-state'; readonly epoch: number; readonly page: ScreenPageIdentity | null; readonly pointer: ScreenPointer | null }
  | { readonly type: 'viewport-pointer'; readonly epoch: number; readonly leaseId: string; readonly pointer: PresentedScreenPointer | null; readonly clearId: number; readonly frame?: ScreenViewportFrame }
  | { readonly type: 'viewport-frame'; readonly epoch: number; readonly leaseId: string; readonly frame: ScreenViewportFrame; readonly pointer: PresentedScreenPointer | null }
  | { readonly type: 'viewport-ready'; readonly epoch: number; readonly leaseId: string }
  | {
      readonly type: 'frame-size';
      readonly epoch: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'stats';
      readonly epoch: number;
      readonly feed: ScreenFeedStats;
      readonly viewports: readonly ScreenViewportStats[];
    }
  | {
      readonly type: 'error';
      readonly epoch: number;
      readonly failure: ScreenFeedFailure;
      readonly fatal: boolean;
    }
  | { readonly type: 'closed'; readonly epoch: number };
