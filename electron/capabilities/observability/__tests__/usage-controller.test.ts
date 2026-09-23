import { describe, expect, it, vi } from 'vitest';
import { OBSERVABILITY_OPERATIONS } from '../../../../shared/electron-contracts/observability.js';
import type { AppSettings } from '../../../../shared/types/index.js';
import type { DesktopPresentationPort } from '../../../desktop/desktop-presentation-port.js';
import type { ModelUsageService } from '../../../observability/usage/model-usage-service.js';
import { createUsageController } from '../usage-controller.js';

const context = {
  generation: 'generation-one', connectionId: 'connection-one', windowId: 1,
  signal: new AbortController().signal,
};

function setup(file?: string, language: AppSettings['language'] = 'zh-CN') {
  const chooseSavePath = vi.fn<DesktopPresentationPort['chooseSavePath']>().mockResolvedValue(file);
  const exportUsage = vi.fn<ModelUsageService['export']>().mockResolvedValue(12);
  const operation = createUsageController(
    { export: exportUsage } as unknown as ModelUsageService,
    { chooseSavePath } as unknown as DesktopPresentationPort,
  ).find(({ id }) => id === OBSERVABILITY_OPERATIONS.usageExport)!;
  return { exportUsage, chooseSavePath, execute: () => operation.execute(context, operation.input.parse(['snapshot', language])) };
}

describe('model usage export', () => {
  it('returns a normal cancelled result without writing a file', async () => {
    const { execute, exportUsage } = setup();
    await expect(execute()).resolves.toBeNull();
    expect(exportUsage).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'en-US'] as const)('exports the selected snapshot in %s and returns the saved file summary', async (language) => {
    const { execute, exportUsage, chooseSavePath } = setup('/exports/usage.csv', language);
    await expect(execute()).resolves.toEqual({ exportedCount: 12, fileName: 'usage.csv' });
    expect(exportUsage).toHaveBeenCalledWith('snapshot', '/exports/usage.csv', language);
    expect(chooseSavePath).toHaveBeenCalledWith(1, expect.objectContaining({ title: language === 'zh-CN' ? '导出模型用量' : 'Export model usage' }));
  });

  it('preserves write failures as errors', async () => {
    const { execute, exportUsage } = setup('/exports/usage.csv');
    exportUsage.mockRejectedValue(new Error('Disk is full'));
    await expect(execute()).rejects.toThrow('Disk is full');
  });
});
