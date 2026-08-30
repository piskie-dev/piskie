import fs from 'node:fs/promises';
import { z } from 'zod';
import { parsePersistedConfig } from '../../config/core/persisted-config-parser.js';
import type { ModelTarget } from '../execution/contracts.js';
import type { InferenceConfigPaths } from './config-repository.js';

const targetSchema = z.strictObject({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});

const selectionDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  ai: targetSchema.optional(),
  image: targetSchema.optional(),
});

export interface InferenceSelections {
  schemaVersion: 1;
  revision: number;
  ai?: ModelTarget;
  image?: ModelTarget;
}

export class InferenceSelectionStore {
  private controlled?: InferenceSelections;

  constructor(private readonly paths: InferenceConfigPaths) {}

  async read(): Promise<InferenceSelections> {
    if (this.controlled) return structuredClone(this.controlled);
    const source = await fs.readFile(this.paths.selectionFile, 'utf8');
    return parsePersistedConfig(
      JSON.parse(source),
      (candidate) => selectionDocumentSchema.parse(candidate),
    );
  }

  /** ConfigHost publication bridge for runtime selection consumers. */
  publishSelections(selections: InferenceSelections): void {
    this.controlled = structuredClone(selections);
  }
}
