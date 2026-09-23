import path from 'node:path';
import { z } from 'zod';
import { OBSERVABILITY_OPERATIONS as operations } from '../../../shared/electron-contracts/observability.js';
import type { UsageFilter, UsageSort } from '../../../shared/types/model-usage.js';
import type { AppSettings } from '../../../shared/types/index.js';
import type { DesktopPresentationPort } from '../../desktop/desktop-presentation-port.js';
import type { ModelUsageService } from '../../observability/usage/model-usage-service.js';
import { usageExportTitle } from '../../observability/usage/usage-csv.js';
import type { OperationDefinition } from '../catalog.js';
import { args, identifier } from '../validation.js';
import { PublicOperationError } from '../public-errors.js';

const key = z.string().max(1024).optional();
const time = z.number().int().min(0).max(8_640_000_000_000_000).optional();
export const usageFilterSchema = z.strictObject({
  from: time, to: time, mainAgentId: key, providerId: key, modelTarget: key,
  agentType: key, agentId: key, protocol: key, reasoning: key, requestId: key,
  purpose: z.enum(['inference', 'compaction', 'test']).optional(),
  status: z.enum(['running', 'success', 'failed', 'cancelled', 'interrupted']).optional(),
}).refine((f) => f.from === undefined || f.to === undefined || f.from < f.to, 'End time must be after start time.');

export function createUsageController(usage: ModelUsageService, presentation: DesktopPresentationPort): OperationDefinition[] {
  return [
    { id: operations.usageQuery, capability: 'observability', input: args([usageFilterSchema]),
      execute: (context, [filter]) => usage.query(filter as UsageFilter, context.signal) },
    { id: operations.usagePage, capability: 'observability', input: args([identifier, z.number().int().min(0).max(100_000), z.enum(['startedAt', 'tokens', 'duration']), z.boolean()]),
      execute: (_context, [id, offset, sort, descending]) => usage.page(id as string, offset as number, sort as UsageSort, descending as boolean) },
    { id: operations.usageDetail, capability: 'observability', input: args([identifier, identifier]),
      execute: (_context, [snapshot, id]) => usage.detail(snapshot as string, id as string) },
    { id: operations.usageStatus, capability: 'observability', input: args([]), execute: () => usage.store.status() },
    { id: operations.usagePreview, capability: 'observability', input: args([z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.null()]), z.boolean()]),
      execute: (_context, [days, all]) => usage.preview(days as number | null, all as boolean) },
    { id: operations.usageCleanup, capability: 'observability', input: args([z.boolean(), z.boolean()]),
      execute: (_context, [all, confirmed]) => {
        if (all && !confirmed) throw new PublicOperationError('invalid-input', 'Clearing usage history requires confirmation.');
        return usage.cleanup(all as boolean);
      } },
    { id: operations.usageExport, capability: 'observability', input: args([identifier, z.enum(['zh-CN', 'en-US'])]),
      execute: async (context, [snapshot, language]) => {
        const exportLanguage = language as AppSettings['language'];
        const file = await presentation.chooseSavePath(context.windowId, {
          title: usageExportTitle[exportLanguage], suggestedName: `model-usage-${new Date().toISOString().slice(0, 10)}.csv`, extensions: ['csv'],
        });
        if (!file) return null;
        const exportedCount = await usage.export(snapshot as string, file, exportLanguage);
        return { exportedCount, fileName: path.basename(file) };
      } },
  ];
}
