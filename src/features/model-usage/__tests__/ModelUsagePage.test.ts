import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageFilter, UsageRecord, UsageReport } from '../../../../shared/types/model-usage';
import { summarizeUsage, matchesUsage } from '../../../../shared/model-usage';
import { ModelUsagePage } from '../ModelUsagePage';
import { UsageSettings } from '../UsageSettings';
import { UsageOverview } from '../UsageOverview';
import i18n from 'i18next';

let container: HTMLDivElement;
let root: Root;
let dom: JSDOM;
const records: UsageRecord[] = [
  { schemaVersion: 1, id: 'gateway:1', runId: 'gateway', attempt: 1, startedAt: Date.now(), purpose: 'inference',
    mainAgentId: 'session-1', runName: 'Example session', requestId: 'request-1', agentId: 'main', agentType: 'main', providerId: 'p', providerName: 'Provider', modelId: 'model', modelName: 'Model', protocol: 'test', configRevision: 0, status: 'success', usage: { totalInputTokens: 100, totalOutputTokens: 20 } },
  { schemaVersion: 1, id: 'probe:1', runId: 'probe', attempt: 1, startedAt: Date.now(), purpose: 'test', providerId: 'p', providerName: 'Provider', modelId: 'model', modelName: 'Model', protocol: 'test', configRevision: 0, status: 'success', usage: {} },
];
function report(filter: UsageFilter): UsageReport {
  const rows = records.filter((r) => matchesUsage(r, filter));
  const group = (key: 'modelId' | 'providerId' | 'mainAgentId' | 'agentType' | 'purpose') => [...new Set(rows.map((r) => r[key] ?? ''))].map((id) => ({ id, label: key === 'mainAgentId' ? id ? 'Example session' : '' : id, summary: summarizeUsage(rows.filter((r) => (r[key] ?? '') === id)) }));
  return { snapshotId: 'snapshot', createdAt: Date.now(), revision: 1, filter, summary: summarizeUsage(rows), records: rows, total: rows.length,
    groups: { modelId: group('modelId'), providerId: group('providerId'), mainAgentId: group('mainAgentId'), agentType: group('agentType'), purpose: group('purpose') },
    trend: [{ at: Date.now() - 1000, to: Date.now() + 1000, summary: summarizeUsage(rows) }],
    facets: { mainAgentId: [{ id: 'session-1', label: 'Example session' }], providerId: [{ id: 'p', label: 'Provider' }], modelTarget: [{ id: '["p","model"]', label: 'Model' }], agentType: [], agentId: [], protocol: [], reasoning: [] },
    storage: { revision: 1, bytes: 1024, files: 1 }, corruptLines: 0 };
}
const query = vi.fn(async (filter: UsageFilter) => report(filter));
const preview = vi.fn(async () => ({ files: 2, records: 40, bytes: 1024, skippedFiles: 1, cutoff: '2026-08-20' }));
const cleanup = vi.fn(async () => ({ files: 2, records: 40, bytes: 1024, skippedFiles: 1 }));
const plan = vi.fn(async () => ({ id: 'plan' }));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement); vi.stubGlobal('HTMLDialogElement', dom.window.HTMLDialogElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    inference: { queryModels: async () => ({ availableTargets: [{ providerId: 'p', modelId: 'model' }] }) },
    observability: { modelUsage: { query, status: async () => ({ revision: 1 }), previewCleanup: preview, cleanup,
      detail: async (_snapshot: string, id: string) => ({ record: records.find((r) => r.id === id), related: records }),
      page: async () => ({ records, total: 2 }), export: vi.fn() } },
    configuration: {
      read: async () => ({ schemaVersion: 1, revision: 0, retentionDays: 90 }),
      describe: async () => ({ domain: 'model-usage', descriptorHash: 'hash', fields: ['/retentionDays'].map((pathTemplate) => ({ fieldId: pathTemplate, pathTemplate, source: 'domain', mutability: 'write' })) }),
      plan, validate: async () => ({ validation: { valid: true } }), apply: async () => ({ revision: 1 }), verify: async () => ({ healthy: true }),
    },
  } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); await i18n.changeLanguage('zh-CN'); container.remove(); dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function render(element: React.ReactElement) { await act(async () => root.render(element)); await act(async () => { await vi.advanceTimersByTimeAsync(110); }); }
async function click(text: string, within: ParentNode = container) {
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
  expect(button, text).toBeDefined(); await act(async () => button!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(110); });
}
async function selectRange(value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="时间范围"]')!;
    select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(110);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(110); });
}
async function chooseFilter(label: string, choice: string) {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="筛选条件"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  const option = [...container.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((node) => node.querySelector('strong')?.textContent === choice)!;
  await act(async () => option.click());
  await click('完成');
}
async function openFirstCall() {
  await act(async () => container.querySelector<HTMLButtonElement>('table tbody td[data-field=model] button')!.click());
}

describe('A report interactions', () => {
  it('plots tokens and calls together on independent axes and keeps each scale independent of the other legend', async () => {
    const monthly = report({});
    const samples = Array.from({ length: 3 }, (_, i) => ({ ...records[0]!, id: `sample-${i}`, usage: { totalInputTokens: 1_000_000, totalOutputTokens: 10_000, cachedInputTokens: 400_000 } }));
    monthly.trend = [summarizeUsage(samples), summarizeUsage([{ ...samples[0]!, usage: { totalInputTokens: 2_000_000, totalOutputTokens: 20_000, cachedInputTokens: 800_000 } }])].map((summary, i) => ({ at: i * 86_400_000, to: (i + 1) * 86_400_000, summary }));
    await render(React.createElement(UsageOverview, { report: monthly, drill: vi.fn() }));
    const chart = container.querySelector('svg[aria-label="用量趋势"]')!;
    const panel = chart.closest('section')!;
    const path = (series: string) => chart.querySelector(`path[data-series="${series}"]`);
    expect(chart.querySelectorAll('path[data-series]')).toHaveLength(4);
    expect([...chart.querySelectorAll('[data-axis=calls] > text')].map((node) => node.textContent)).toEqual(['调用次数（右轴）', '0', '2', '4']);
    expect(path('calls')?.getAttribute('stroke-dasharray')).toBeTruthy();
    const input = path('input')!.getAttribute('d');
    const calls = path('calls')!.getAttribute('d');
    expect(input).toMatch(/^M58 35 /);
    expect(calls).toMatch(/^M58 73.75 /);
    await click('调用次数', panel);
    expect(path('calls')).toBeNull();
    expect(path('input')?.getAttribute('d')).toBe(input);
    await click('调用次数', panel);
    await click('输入', panel);
    expect(path('calls')?.getAttribute('d')).toBe(calls);
    expect(container.textContent).toContain('120 Token · 2 次调用');
  });

  it('keeps unknown tokens as gaps, empty days at zero and time drilldown within the active filter', async () => {
    const sample = report({ from: 1250, to: 4250 });
    sample.trend = [summarizeUsage([records[0]!]), summarizeUsage([records[1]!]), summarizeUsage([]), summarizeUsage([records[0]!])].map((summary, i) => ({ at: (i + 1) * 1000, to: (i + 2) * 1000, summary }));
    const drill = vi.fn();
    await render(React.createElement(UsageOverview, { report: sample, drill }));
    const chart = container.querySelector('svg[aria-label="用量趋势"]')!;
    const points = chart.querySelectorAll<SVGGElement>('g[role=button]');
    const input = chart.querySelector('path[data-series=input]')!.getAttribute('d')!;
    expect(input.match(/M/g)).toHaveLength(2);
    expect(input.match(/L/g)).toHaveLength(1);
    expect(points[1]!.querySelectorAll('circle')).toHaveLength(1);
    expect(points[1]!.getAttribute('aria-label')).toContain('输入: — Token');
    expect(points[2]!.querySelectorAll('circle')).toHaveLength(4);
    expect([...points[2]!.querySelectorAll('circle')].every((node) => node.getAttribute('cy') === '190')).toBe(true);
    expect([...chart.querySelectorAll('[data-axis=calls] > text')].map((node) => node.textContent)).toEqual(['调用次数（右轴）', '0', '1', '2']);
    await act(async () => points[0]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(drill).toHaveBeenLastCalledWith({ from: 1250, to: 2000 });
    await act(async () => points[3]!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(drill).toHaveBeenLastCalledWith({ from: 4000, to: 4250 });
  });

  it('leaves the report intact without an error or success notice when export is cancelled', async () => {
    const exportUsage = vi.spyOn(window.piskie.observability.modelUsage, 'export').mockResolvedValue(null);
    await render(React.createElement(ModelUsagePage));
    await click('调用明细');
    const before = container.textContent;
    await click('导出 CSV');
    expect(exportUsage).toHaveBeenCalledWith('snapshot', 'zh-CN');
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.querySelector('[role=status]')).toBeNull();
    expect(container.textContent).toBe(before);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('shows confirmation only after export succeeds', async () => {
    vi.spyOn(window.piskie.observability.modelUsage, 'export').mockResolvedValue({ exportedCount: 2, fileName: 'usage.csv' });
    await render(React.createElement(ModelUsagePage));
    await click('导出 CSV');
    expect(container.querySelector('[role=status]')?.textContent).toBe('已导出 2 条记录至 usage.csv');
    expect(container.querySelector('[role=alert]')).toBeNull();
  });

  it('uses the current interface language for export', async () => {
    const exportUsage = vi.spyOn(window.piskie.observability.modelUsage, 'export').mockResolvedValue(null);
    await render(React.createElement(ModelUsagePage));
    await act(async () => { await i18n.changeLanguage('en-US'); });
    await click('Export CSV');
    expect(exportUsage).toHaveBeenCalledWith('snapshot', 'en-US');
  });

  it('still reports an actual export failure', async () => {
    vi.spyOn(window.piskie.observability.modelUsage, 'export').mockRejectedValue(new Error('Disk is full'));
    await render(React.createElement(ModelUsagePage));
    await click('导出 CSV');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Disk is full');
    expect(container.querySelector('[role=status]')).toBeNull();
  });

  it('makes task drilldown temporary and restores the original manually selected filters', async () => {
    await render(React.createElement(ModelUsagePage));
    await selectRange('30');
    await chooseFilter('Provider', 'Provider');
    const original = query.mock.calls.at(-1)![0];
    expect(original.providerId).toBe('p');
    expect(container.querySelectorAll('[role=tab]')).toHaveLength(2);
    expect(container.textContent).not.toContain('最近调用');
    const ranking = [...container.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === '会话 / 任务用量排行')!;
    expect(ranking.querySelectorAll('[role=tab]')).toHaveLength(0);
    await click('Example session', ranking);
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ mainAgentId: 'session-1' }));
    expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('调用明细');
    const context = container.querySelector('[role=region][aria-label="临时查看调用明细"]')!;
    expect(context.textContent).toContain('会话 / 任务: Example session');
    expect(context.textContent).toContain('筛选仅用于本次明细，返回后恢复原范围。');
    expect(document.activeElement).toBe(context);
    await chooseFilter('状态', '失败');
    expect(container.textContent).toContain('当前筛选没有匹配调用');
    query.mockImplementationOnce(async (filter) => {
      const empty = report(filter); empty.facets.mainAgentId = []; empty.facets.providerId = []; return empty;
    });
    await selectRange('1');
    expect(context.textContent).toContain('会话 / 任务: Example session');
    expect(context.textContent).toContain('Provider: Provider');
    await click('返回总览');
    expect(query).toHaveBeenLastCalledWith(original);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="时间范围"]')!.value).toBe('30');
    expect(container.querySelector('[role=region]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[role=tab][aria-selected=true]'));
    expect(container.querySelector('[data-metric=calls] strong')?.textContent).toBe('2');
    expect(container.textContent).toContain('Provider: Provider');
    const count = query.mock.calls.length;
    await click('调用明细');
    expect(query).toHaveBeenCalledTimes(count);
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2);
  });

  it('restores the original date range when returning through the overview tab after time drilldown', async () => {
    await render(React.createElement(ModelUsagePage));
    await selectRange('30');
    const original = query.mock.calls.at(-1)![0];
    await act(async () => container.querySelector('svg[aria-label="用量趋势"] g[role=button]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(110); });
    expect(query.mock.calls.at(-1)![0].from).toBeGreaterThan(original.from!);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="时间范围"]')!.value).toBe('custom');
    expect(container.querySelector('[role=region] button[title^="时间范围:"]')?.textContent).toMatch(/\d{2}:\d{2}/);
    await click('用量总览');
    expect(query).toHaveBeenLastCalledWith(original);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="时间范围"]')!.value).toBe('30');
    expect(container.querySelector('[role=region]')).toBeNull();
    expect(container.querySelector('[data-metric=calls] strong')?.textContent).toBe('2');
  });

  it('returns nested detail links to the original calls filter without leaking the request scope', async () => {
    await render(React.createElement(ModelUsagePage));
    await chooseFilter('状态', '成功');
    const original = query.mock.calls.at(-1)![0];
    await click('调用明细');
    await openFirstCall();
    await click('查看该请求调用');
    expect(query.mock.calls.at(-1)![0]).toMatchObject({ requestId: 'request-1', mainAgentId: 'session-1', agentId: 'main', status: undefined });
    expect(container.querySelector('[role=region]')?.textContent).toContain('逻辑请求: request-1');
    await openFirstCall();
    await click('查看该会话调用');
    await click('清除条件', container.querySelector('[role=region]')!);
    await click('返回原调用列表');
    expect(query).toHaveBeenLastCalledWith(original);
    expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('调用明细');
    expect(container.querySelector('[role=region]')).toBeNull();
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2);
    await click('用量总览');
    expect(container.textContent).toContain('状态: 成功');
  });

  it('ignores a late drilldown response after returning to overview', async () => {
    await render(React.createElement(ModelUsagePage));
    const original = query.mock.calls.at(-1)![0];
    let resolve!: (value: UsageReport) => void;
    query.mockImplementationOnce(() => new Promise<UsageReport>((done) => { resolve = done; }));
    await click('Example session');
    const narrowed = query.mock.calls.at(-1)![0];
    expect(container.querySelector('[role=region]')?.textContent).toContain('会话 / 任务: Example session');
    await click('用量总览');
    expect(query).toHaveBeenLastCalledWith(original);
    await act(async () => resolve(report(narrowed)));
    expect(container.querySelector('[data-metric=calls] strong')?.textContent).toBe('2');
    expect(container.querySelector('[role=region]')).toBeNull();
  });

  it('requires a preview and explicit confirmation before shortening retention or clearing history', async () => {
    await render(React.createElement(UsageSettings, { open: true, close: vi.fn(), changed: vi.fn() }));
    await click('30 天'); await click('保存设置');
    expect(preview).toHaveBeenCalledWith(30, false);
    expect(plan).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    const confirmation = [...container.querySelectorAll('dialog')].find((dialog) => dialog.textContent?.includes('确认缩短保留周期'))!;
    expect(confirmation.textContent).toContain('40 次调用');
    await click('确认', confirmation);
    expect(plan).toHaveBeenCalledWith('model-usage', expect.objectContaining({ changes: expect.arrayContaining([expect.objectContaining({ fieldId: '/retentionDays', value: 30 })]) }));
    expect(cleanup).toHaveBeenCalledWith(false, false);
    await click('清空报表历史');
    expect(preview).toHaveBeenLastCalledWith(null, true);
    expect(cleanup).not.toHaveBeenCalledWith(true, true);
  });

  it('edits retention settings without depending on model configuration', async () => {
    const models = vi.spyOn(window.piskie.inference, 'queryModels').mockRejectedValue(new Error('Model discovery unavailable'));
    const read = vi.spyOn(window.piskie.configuration, 'read');
    await render(React.createElement(UsageSettings, { open: true, close: vi.fn(), changed: vi.fn() }));
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.textContent).not.toMatch(/费用|单价|币种/);
    await click('180 天'); await click('保存设置');
    expect(plan).toHaveBeenCalledWith('model-usage', expect.objectContaining({ changes: [expect.objectContaining({ fieldId: '/retentionDays', value: 180 })] }));
    expect(cleanup).toHaveBeenCalledWith(false, false);
    expect(models).not.toHaveBeenCalled();
    expect(read.mock.calls.every(([domain]) => domain === 'model-usage')).toBe(true);
  });
});
