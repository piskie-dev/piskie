import { Boxes, PlugZap, Sparkles } from 'lucide-react';

import type { MarketEntryKind } from '@shared/types/market';

import styles from './market.module.css';

export const kindGlyph = (kind: MarketEntryKind) => {
  if (kind === 'mcp') return <PlugZap aria-hidden />;
  if (kind === 'plugin') return <Boxes aria-hidden />;
  return <Sparkles aria-hidden />;
};

export const kindGlyphClass = (kind: MarketEntryKind) => {
  if (kind === 'mcp') return styles.glyphMcp;
  if (kind === 'plugin') return styles.glyphPlugin;
  return styles.glyphSkill;
};

export const kindTag = (kind: MarketEntryKind, executable?: boolean) => {
  if (kind === 'mcp') return 'mcp' as const;
  if (kind === 'plugin') return 'plugin' as const;
  return executable ? 'executable' as const : 'skill' as const;
};
