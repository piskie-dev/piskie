const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const instance = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'SVGElement', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: name === 'window' ? instance.window : instance.window[name] });
  }
  return instance;
});

import i18n from 'i18next';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelUsageConfig, ProviderTokenBudgetStatus } from '@shared/types/model-usage';
import '@/i18n';
import { ProviderTokenBudget } from '../ProviderTokenBudget';

let root: Root;
let container: HTMLDivElement;
let config: ModelUsageConfig;
let status: ProviderTokenBudgetStatus | null;
const plan = vi.fn(async (_domain: string, request: { changes: Array<{ value: Record<string, unknown> }> }) => {
  config = { ...config, revision: config.revision + 1, providerBudgets: request.changes[0]!.value } as ModelUsageConfig;
  const budget = config.providerBudgets!.sample;
  status = budget ? { budget, periodStart: Date.now(), periodEnd: Date.now() + 86_400_000,
    used: 120, remaining: budget.limit - 120, unmeasuredCalls: 0, complete: true } : null;
  return { id: 'plan' };
});

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});

beforeEach(() => {
  vi.clearAllMocks();
  config = { schemaVersion: 1, revision: 0, retentionDays: 90 };
  status = null;
  Object.defineProperty(dom.window, 'piskie', { configurable: true, value: {
    configuration: {
      read: async () => config,
      describe: async () => ({ domain: 'model-usage', descriptorHash: 'hash', fields: [
        { fieldId: 'budgets', pathTemplate: '/providerBudgets', source: 'domain', mutability: 'write', bindings: [] },
      ] }),
      plan, validate: async () => ({ validation: { valid: true } }),
      apply: async () => ({ revision: config.revision }),
      verify: async () => ({ healthy: true }),
    },
    observability: { modelUsage: { budget: async () => status } },
  } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('provider token budget', () => {
  it('saves the first budget and displays the local remaining amount', async () => {
    await act(async () => root.render(createElement(ProviderTokenBudget, { providerId: 'sample' })));
    const add = container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('settings.provider.tokenBudget.add')}"]`)!;
    expect(add).not.toBeNull();
    await act(async () => add.click());
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '1000');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('dialog button')]
        .find((button) => button.textContent === i18n.t('common.save'))!.click();
    });
    expect(plan).toHaveBeenCalledWith('model-usage', expect.objectContaining({
      changes: [expect.objectContaining({ fieldId: 'budgets', value: { sample: expect.objectContaining({ limit: 1000 }) } })],
    }));
    expect(container.textContent).toContain('880');
  });

  it('shows an unknown remainder when calls have missing usage', async () => {
    const budget = { period: 'weekly' as const, limit: 1000, resetAt: Date.now() };
    config = { ...config, providerBudgets: { sample: budget } };
    status = { budget, periodStart: Date.now(), periodEnd: Date.now() + 86_400_000,
      used: 100, unmeasuredCalls: 1, complete: false };
    await act(async () => root.render(createElement(ProviderTokenBudget, { providerId: 'sample' })));
    expect(container.textContent).toContain(i18n.t('settings.provider.tokenBudget.incomplete'));
    expect(container.textContent).not.toContain('900');
  });

  it('removes the budget and returns to the unset state', async () => {
    const budget = { period: 'weekly' as const, limit: 1000, resetAt: Date.now() };
    config = { ...config, providerBudgets: { sample: budget } };
    status = { budget, periodStart: Date.now(), periodEnd: Date.now() + 86_400_000,
      used: 100, remaining: 900, unmeasuredCalls: 0, complete: true };
    await act(async () => root.render(createElement(ProviderTokenBudget, { providerId: 'sample' })));
    await act(async () => container.querySelector<HTMLButtonElement>(
      `button[aria-label="${i18n.t('settings.provider.tokenBudget.edit')}"]`,
    )!.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('dialog button')]
        .find((button) => button.textContent === i18n.t('settings.provider.tokenBudget.remove'))!.click();
    });
    expect(config.providerBudgets).toEqual({});
    expect(container.textContent).toContain(i18n.t('settings.provider.tokenBudget.unset'));
  });
});
