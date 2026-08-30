import type { MarketChangeEvent } from '../../shared/types/market.js';
import { createChangeChannel, type ChangeSink, type ChangeSource } from '../core/change-channel.js';

export interface MarketChanges {
  source: ChangeSource<MarketChangeEvent>;
  sink: ChangeSink<MarketChangeEvent>;
}

export function createMarketChanges(
  onSubscriberError?: (error: unknown, change: MarketChangeEvent) => void,
): MarketChanges {
  return createChangeChannel<MarketChangeEvent>({ onSubscriberError });
}
