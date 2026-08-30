import catalogJson from './generated/catalog.json' with { type: 'json' };
import type { GeneratedModelCatalog } from './types.js';

export const AI_MODEL_CATALOG = catalogJson as GeneratedModelCatalog;

export * from './types.js';
export * from './reasoning-presets.js';
