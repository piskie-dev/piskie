import { guardMutation } from './guard-mutation.js';
import { normalizePaths } from './normalize-paths.js';
import { parseParams } from './parse-params.js';
import { persistOverflow } from './persist-overflow.js';
import { preparePreview } from './prepare-preview.js';
import { requireApproval } from './require-approval.js';
import type { AdmitStep, FinalizeStep, PrepareStep } from './types.js';

/** The sole declaration of cross-cutting pipeline order. */
export const PREPARE: readonly PrepareStep[] = [parseParams, normalizePaths];
export const ADMIT: readonly AdmitStep[] = [guardMutation, preparePreview, requireApproval];
export const FINALIZE: readonly FinalizeStep[] = [persistOverflow];
