const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceConfig, InferenceModelDefinition } from '../../../../../../shared/types/inference';
import type { ReasoningSelection } from '../../../../../../shared/types/reasoning';
import { useInferenceStore } from '../../../../../store/inferenceStore';
import { clearAllComposerDrafts } from '../../../data/composer-drafts';
import { ConversationComposer } from '../ConversationComposer';

const runtime = vi.hoisted(() => ({
  agentCommands: { setReasoning: vi.fn(), setSubagentReasoning: vi.fn() },
}));
vi.mock('../../../../../renderer-runtime/hooks', () => ({ useRendererRuntime: () => runtime }));
vi.mock('../../../chrome/Popover', () => ({
  Popover: ({ trigger, children, open }: { trigger: ReactNode; children: ReactNode; open: boolean }) =>
    createElement('div', null, trigger, open ? children : null),
}));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));

const low = { kind: 'effort', effort: 'low' } as const;
const medium = { kind: 'effort', effort: 'medium' } as const;
const high = { kind: 'effort', effort: 'high' } as const;
const definition: InferenceModelDefinition = {
  id: 'sample-catalog/chat', displayName: 'Sample model', kind: 'ai', lifecycle: 'active',
  compatibleDrivers: ['openai'], inputModalities: ['text'], outputModalities: ['text'],
  capabilities: { streaming: true, tools: true }, limits: { contextWindow: 128_000 },
  source: { kind: 'local', version: 'sample' },
  reasoning: {
    mode: 'effort', options: [{ kind: 'provider-default' }, { kind: 'disabled' }, low, medium, high],
    defaultSelection: medium, mandatory: false, transportPreset: 'openai-effort', replayPolicy: 'none',
  },
};
const actualDefaultUpdate = useInferenceStore.getState().updateModelReasoningDefault;
const saveDefault = vi.fn<(model: string, selection: ReasoningSelection) => Promise<boolean>>();
const submit = vi.fn().mockResolvedValue(false);
const interrupt = vi.fn().mockResolvedValue(undefined);
const targetKey = (agentId: string, workerId?: string) => workerId ?? agentId;
interface Target {
  agentId: string;
  workerId?: string;
  model: string;
  reasoningOverride: ReasoningSelection;
}
let targets: Target[];
let root: Root;
let container: HTMLDivElement;

function configured(defaultReasoning: ReasoningSelection): InferenceConfig {
  const binding = { catalogId: definition.id, upstreamId: 'sample-model', enabled: true, options: {}, defaultReasoning };
  return {
    schemaVersion: 1, revision: 1,
    providers: {
      'sample-provider': {
        displayName: 'Sample provider', driver: 'openai', enabled: true,
        connection: { baseUrl: 'https://example.com/v1', auth: { kind: 'none' }, headers: {}, proxyId: null },
        models: { 'main-model': { ...binding }, 'worker-model': { ...binding } }, driverOptions: {},
      },
    },
    policies: {
      ai: { maxAttempts: 1, connectTimeoutMs: 1_000, streamIdleTimeoutMs: 1_000, retryBaseDelayMs: 1 },
      image: { maxSubmitAttempts: 1, submitTimeoutMs: 1_000, operationTimeoutMs: 1_000, allowResubmitAfterAccepted: false },
    },
  };
}

function publishDefault(model: string, selection: ReasoningSelection) {
  const config = structuredClone(useInferenceStore.getState().config!);
  const [providerId, modelId] = model.split('::');
  config.providers[providerId!]!.models[modelId!]!.defaultReasoning = selection;
  useInferenceStore.setState({ config });
}

function Harness() {
  return createElement('div', null, targets.map((target) => createElement('section', {
    key: targetKey(target.agentId, target.workerId), 'data-target': targetKey(target.agentId, target.workerId),
  }, createElement(ConversationComposer, {
    ...target, targetName: 'Example target', approvalMode: 'auto', sourceVersion: 0,
    canPause: false, onSubmit: submit, onInterrupt: interrupt,
  }))));
}
const render = () => root.render(createElement(Harness));
const panel = (key: string) => container.querySelector<HTMLElement>(`[data-target="${key}"]`)!;
const trigger = (key: string) => panel(key).querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
const chips = (key: string) => [...panel(key).querySelectorAll<HTMLButtonElement>('[class*="chip"]')];
const selected = (key: string) => chips(key).filter((chip) => chip.dataset.selected === 'true').map((chip) => chip.textContent);
async function open(key: string) { await act(async () => trigger(key).click()); }
async function choose(key: string, label: string) {
  const chip = chips(key).find((item) => item.textContent === label)!;
  await act(async () => chip.click());
}
function updateTarget(agentId: string, workerId: string | undefined, selection: ReasoningSelection) {
  targets = targets.map((target) => target.agentId === agentId && target.workerId === workerId
    ? { ...target, reasoningOverride: selection } : target);
  render();
  return Promise.resolve({ ok: true });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    modes: { listAvailable: vi.fn().mockResolvedValue([]) },
  } });
  clearAllComposerDrafts();
  targets = [
    { agentId: 'session-example', model: 'sample-provider::main-model', reasoningOverride: medium },
    { agentId: 'session-example', workerId: 'worker-example', model: 'sample-provider::worker-model', reasoningOverride: low },
    { agentId: 'session-example', workerId: 'worker-sibling', model: 'sample-provider::worker-model', reasoningOverride: low },
    { agentId: 'session-other', model: 'sample-provider::main-model', reasoningOverride: medium },
  ];
  runtime.agentCommands.setReasoning.mockReset().mockImplementation((agentId, selection) => updateTarget(agentId, undefined, selection));
  runtime.agentCommands.setSubagentReasoning.mockReset().mockImplementation(updateTarget);
  saveDefault.mockReset().mockImplementation(async (model, selection) => { publishDefault(model, selection); return true; });
  useInferenceStore.setState({
    config: configured(medium), models: { ai: [definition], image: [] },
    availableTargets: { ai: ['main-model', 'worker-model'].map((modelId) => ({
      providerId: 'sample-provider', modelId, catalogId: definition.id,
    })), image: [] },
    updateModelReasoningDefault: saveDefault,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearAllComposerDrafts();
  useInferenceStore.setState({ updateModelReasoningDefault: actualDefaultUpdate });
  vi.unstubAllGlobals();
});

afterAll(() => testDOM.window.close());

describe.each(['main', 'worker'] as const)('%s reasoning selection', (variant) => {
  const key = variant === 'main' ? 'session-example' : 'worker-example';
  const model = `sample-provider::${variant}-model`;

  it('updates only the selected runtime and its display, saving the model default for the main Agent only', async () => {
    await act(async () => render());
    for (const target of targets) await open(targetKey(target.agentId, target.workerId));
    expect(selected('session-example')).toEqual(['中']);
    expect(selected('worker-example')).toEqual(['低']);
    expect(saveDefault).not.toHaveBeenCalled();

    await choose(key, '高');

    if (variant === 'main') {
      // 主 Agent：先保存模型默认值，再写运行时。
      expect(saveDefault).toHaveBeenCalledExactlyOnceWith(model, high);
      expect(runtime.agentCommands.setReasoning).toHaveBeenCalledExactlyOnceWith('session-example', high);
      expect(runtime.agentCommands.setSubagentReasoning).not.toHaveBeenCalled();
      expect(saveDefault.mock.invocationCallOrder[0]).toBeLessThan(runtime.agentCommands.setReasoning.mock.invocationCallOrder[0]!);
    } else {
      // Worker：只写自己的运行时，不触碰全局模型默认值。
      expect(saveDefault).not.toHaveBeenCalled();
      expect(runtime.agentCommands.setSubagentReasoning).toHaveBeenCalledExactlyOnceWith('session-example', 'worker-example', high);
      expect(runtime.agentCommands.setReasoning).not.toHaveBeenCalled();
    }
    for (const target of targets) {
      const targetId = targetKey(target.agentId, target.workerId);
      const label = targetId === key ? '高' : target.workerId ? '低' : '中';
      expect(trigger(targetId).getAttribute('aria-label')).toContain(label);
      expect(selected(targetId)).toEqual([label]);
    }
  });

  it('still updates the current runtime when the real store already has the selected default', async () => {
    useInferenceStore.setState({ config: configured(high), updateModelReasoningDefault: actualDefaultUpdate });
    await act(async () => render());
    await open(key);
    await choose(key, '高');
    expect(selected(key)).toEqual(['高']);
    if (variant === 'main') expect(runtime.agentCommands.setReasoning).toHaveBeenCalledExactlyOnceWith('session-example', high);
    else expect(runtime.agentCommands.setSubagentReasoning).toHaveBeenCalledExactlyOnceWith('session-example', 'worker-example', high);
    expect(useInferenceStore.getState().error).toBeNull();
  });

});

it('keeps the main Agent runtime and displayed value when saving the default fails', async () => {
  saveDefault.mockResolvedValue(false);
  await act(async () => render());
  await open('session-example');
  await choose('session-example', '高');
  expect(saveDefault).toHaveBeenCalledExactlyOnceWith('sample-provider::main-model', high);
  expect(runtime.agentCommands.setReasoning).not.toHaveBeenCalled();
  expect(runtime.agentCommands.setSubagentReasoning).not.toHaveBeenCalled();
  expect(selected('session-example')).toEqual(['中']);
});

it('keeps existing labels and menu values through global default refreshes without writing back', async () => {
  useInferenceStore.setState({ config: configured({ kind: 'disabled' }) });
  await act(async () => render());
  for (const target of targets) await open(targetKey(target.agentId, target.workerId));
  await act(async () => {
    publishDefault('sample-provider::main-model', high);
    publishDefault('sample-provider::worker-model', high);
  });
  for (const target of targets) {
    const key = targetKey(target.agentId, target.workerId);
    const label = target.workerId ? '低' : '中';
    expect(trigger(key).getAttribute('aria-label')).toContain(label);
    expect(selected(key)).toEqual([label]);
  }
  expect(saveDefault).not.toHaveBeenCalled();
  expect(runtime.agentCommands.setReasoning).not.toHaveBeenCalled();
  expect(runtime.agentCommands.setSubagentReasoning).not.toHaveBeenCalled();
});

it.each([
  [{ kind: 'provider-default' }, '默认', '供应商默认'],
  [{ kind: 'disabled' }, '关闭', '关闭'],
] as const)('shows the saved %j runtime value even when ordinary choices omit it', async (selection, label, menuLabel) => {
  targets[0]!.reasoningOverride = selection;
  await act(async () => render());
  await open('session-example');
  expect(trigger('session-example').getAttribute('aria-label')).toContain(label);
  expect(selected('session-example')).toEqual([menuLabel]);
  expect(saveDefault).not.toHaveBeenCalled();
});

it('shows and edits the runtime token budget independently of the model default', async () => {
  const budget = { kind: 'budget', tokens: 8192 } as const;
  const budgetDefinition: InferenceModelDefinition = {
    ...definition,
    reasoning: {
      mode: 'budget', options: [budget], defaultSelection: budget, mandatory: true,
      transportPreset: 'anthropic-budget', replayPolicy: 'opaque-required',
      minBudgetTokens: 1024, maxBudgetTokens: 32768,
    },
  };
  targets[0]!.reasoningOverride = { kind: 'budget', tokens: 4096 };
  targets = [targets[0]!];
  useInferenceStore.setState({ config: configured(budget), models: { ai: [budgetDefinition], image: [] } });
  await act(async () => render());
  await open('session-example');
  const input = panel('session-example').querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.value).toBe('4096');
  expect(selected('session-example')).toEqual(['预算 4.1K']);
  expect(trigger('session-example').getAttribute('aria-label')).toContain('4.1K');
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const blur = () => act(async () => { input.dispatchEvent(new Event('focusout', { bubbles: true })); });
  // 超出模型范围的草稿只标记无效，不回写。
  await type('512');
  await blur();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(panel('session-example').querySelector('[class*="reasoningSection"] [role="alert"]')).not.toBeNull();
  expect(saveDefault).not.toHaveBeenCalled();
  expect(runtime.agentCommands.setReasoning).not.toHaveBeenCalled();
  // 输入过程中不回写，失焦后才提交有效值。
  await type('6144');
  expect(saveDefault).not.toHaveBeenCalled();
  await blur();
  expect(saveDefault).toHaveBeenCalledExactlyOnceWith('sample-provider::main-model', { kind: 'budget', tokens: 6144 });
  expect(runtime.agentCommands.setReasoning).toHaveBeenCalledExactlyOnceWith('session-example', { kind: 'budget', tokens: 6144 });
  expect(input.value).toBe('6144');
});
