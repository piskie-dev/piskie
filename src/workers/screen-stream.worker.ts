/// <reference lib="webworker" />

import { createBrowserScreenFeedWorker } from '@/domains/screen-feed/screen-feed-worker';
import type { ScreenWorkerIncomingMessage } from '@/domains/screen-feed/worker-protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const worker = createBrowserScreenFeedWorker(scope);

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') {
    worker.protocolError('Invalid screen worker message');
    return;
  }
  worker.accept(value as ScreenWorkerIncomingMessage);
});
