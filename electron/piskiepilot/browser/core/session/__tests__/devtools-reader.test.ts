import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'puppeteer-core';
import { getDevToolsData, getDevToolsPage } from '../devtools-reader.js';
import { fakePage } from './observation-fixtures.js';

describe('optional DevTools UI metadata', () => {
  it('does not open a panel when DevTools is not already open', async () => {
    const { page } = fakePage();
    expect(await getDevToolsData(page)).toEqual({}); expect(page.openDevTools).not.toHaveBeenCalled();
  });
  it('reads request/backend node IDs from the already-open target page frontend', async () => {
    const { page } = fakePage(); vi.mocked(page.hasDevTools).mockResolvedValue(true);
    const evaluate = vi.fn(async () => ({ cdpRequestId: 'fixture-request', cdpBackendNodeId: 17 }));
    const panel = { evaluate } as unknown as Page; vi.mocked(page.openDevTools).mockResolvedValue(panel);
    expect(await getDevToolsPage(page)).toBe(panel);
    expect(await getDevToolsData(page)).toEqual({ cdpRequestId: 'fixture-request', cdpBackendNodeId: 17 });
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('uses empty metadata for unsupported Chrome commands or frontend evaluation failures', async () => {
    const { page } = fakePage(); vi.mocked(page.hasDevTools).mockRejectedValue(new Error('fixture unsupported command'));
    expect(await getDevToolsData(page)).toEqual({});
    vi.mocked(page.hasDevTools).mockResolvedValue(true);
    vi.mocked(page.openDevTools).mockResolvedValue({ evaluate: async () => { throw new Error('fixture unavailable context'); } } as unknown as Page);
    expect(await getDevToolsData(page)).toEqual({});
  });
});
