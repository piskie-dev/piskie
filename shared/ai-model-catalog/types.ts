import type {
  CapabilityState,
  CatalogProvenance,
  CatalogProviderId,
  ModelCapabilityProfile,
  ModelLifecycle,
  ModelPricing,
  ModelTag,
} from '../types/model-catalog.js';
import type { ReasoningProfile } from '../types/reasoning.js';

interface BaseModelCatalogEntry {
  id: string;
  name: string;
  provider: CatalogProviderId;
  lifecycle: ModelLifecycle;
  releaseDate?: string;
  tags?: ModelTag[];
  pricing?: ModelPricing;
  provenance: CatalogProvenance;
}

export interface AIModelCatalogEntry extends BaseModelCatalogEntry {
  kind?: 'ai';
  capabilityProfile: ModelCapabilityProfile;
  reasoning: ReasoningProfile;
  contextWindow?: number;
  maxContextWindow?: number;
  maxOutputTokens?: number;
}

export interface ImageModelCatalogEntry extends BaseModelCatalogEntry {
  kind: 'image';
  inputModalities: string[];
  outputModalities: string[];
  capabilityProfile: {
    generate: CapabilityState;
    edit: CapabilityState;
    referenceImages: CapabilityState;
    mask: CapabilityState;
  };
  limits?: {
    maxImages?: number;
    sizes?: string[];
    formats?: Array<'png' | 'jpeg' | 'webp'>;
  };
}

export type ModelCatalogEntry = AIModelCatalogEntry | ImageModelCatalogEntry;

export interface ProviderModelCatalog {
  provider: CatalogProviderId;
  version: string;
  verifiedAt: string;
  sourceUrls: string[];
  inventorySource?: {
    id: 'models.dev';
    url: string;
    sha256: string;
  };
  imageInventorySource?: {
    id: 'models.dev' | 'aliyun-docs' | 'baidu-docs' | 'zhipu-docs';
    url: string;
    sha256: string;
  };
  models: ModelCatalogEntry[];
}

export interface GeneratedModelCatalog {
  version: string;
  contentHash: string;
  generatedAt: string;
  providers: Partial<Record<CatalogProviderId, ProviderModelCatalog>>;
}
