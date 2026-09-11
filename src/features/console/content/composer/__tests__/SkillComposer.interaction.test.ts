const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent'] as const) {
    const value = name === 'window' ? dom.window : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return dom;
});

import React, { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerSkillOption } from '../../../../../../shared/types/skill';
import { WelcomeComposer } from '../WelcomeComposer';
import { ConversationComposer } from '../ConversationComposer';
import { clearAllComposerDrafts, composerDraftKey, useComposerDraftStore } from '../../../data/composer-drafts';

vi.mock('../../../../../components/agent-params/ApprovalModeSelector', () => ({ default: () => null }));
vi.mock('../../../../../components/agent-params/ModeSelector', () => ({ default: () => null }));
vi.mock('../../../../../components/BrowserEnvironmentBindingPicker', () => ({ default: () => null }));
vi.mock('../../../../../components/shared', () => ({ ModelReasoningControl: () => null }));
vi.mock('../ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('../useComposerSettings', () => ({ useComposerSettings: () => ({ modelGroups: [] }) }));
vi.mock('../../../chrome/Popover', () => ({ Popover: ({ trigger }: { trigger: React.ReactNode }) => trigger }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../ImageThumbnail', () => ({ ImageThumbnail: () => createElement('img', { alt: 'Sample attachment' }) }));

const options: ComposerSkillOption[] = [
  { name: 'alpha', description: 'Arrange sample notes', scope: 'user' },
  { name: 'beta', description: 'Inspect sample tables', scope: 'project' },
  { name: 'gamma', description: 'Read sample files', scope: 'builtin' },
];
const availableSkills = vi.fn<(workspace?: string) => Promise<ComposerSkillOption[]>>();
const submit = vi.fn().mockResolvedValue(false);
const listeners = new Set<() => void>();
let root: Root;
let container: HTMLDivElement;
const welcomeRef = React.createRef<{ setText: (text: string) => void }>();
let workspace: string | undefined;
let mode: 'welcome' | 'main' | 'worker';
const draftKey = () => composerDraftKey('session-example', mode === 'worker' ? 'worker-example' : undefined);

function Harness() {
  const [text, setText] = useState('');
  const [skills, setSkills] = useState<readonly string[]>([]);
  React.useImperativeHandle(welcomeRef, () => ({ setText }), [setText]);
  if (mode !== 'welcome') return createElement(ConversationComposer, {
    agentId: 'session-example', workerId: mode === 'worker' ? 'worker-example' : undefined,
    workspace, targetName: 'Example target', model: 'example-provider::example-model',
    reasoningOverride: { kind: 'provider-default' },
    approvalMode: 'confirm', sourceVersion: 0, canPause: false,
    onSubmit: submit, onInterrupt: vi.fn(),
  });
  return createElement(WelcomeComposer, {
    value: text, onChange: setText, skills, onSkillsChange: setSkills, draftIdentity: 'welcome:example',
    onSubmit: submit, onPaste: vi.fn(), placeholder: 'Example task', images: [], files: [],
    onRemoveAttachment: vi.fn(), onModelChange: vi.fn(), modeId: 'normal', onModeChange: vi.fn(),
    approvalMode: 'confirm', onApprovalModeChange: vi.fn(), workspaceLabel: 'Example workspace',
    workspacePath: workspace, onSelectWorkspace: vi.fn(), onUseDefaultWorkspace: vi.fn(),
    environmentIds: [], onEnvironmentIdsChange: vi.fn(),
  });
}

const input = () => container.querySelector('textarea')!;
const list = () => container.querySelector('[role="listbox"]');
const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const tagNames = () => [...container.querySelectorAll<HTMLElement>('[class*="tag"] [class*="name"]')].map((tag) => tag.textContent);

async function render() { await act(async () => root.render(createElement(Harness))); }
async function restore(text: string) {
  await act(async () => {
    if (mode === 'welcome') welcomeRef.current!.setText(text);
    else useComposerDraftStore.getState().setDraft(draftKey(), text);
  });
}
async function key(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => input().dispatchEvent(event));
  return event;
}
async function edit(text: string, inputType = 'insertText', data: string | null = text) {
  const element = input();
  await act(async () => {
    const value = element.value.slice(0, element.selectionStart) + text + element.value.slice(element.selectionEnd);
    const caret = element.selectionStart + text.length;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.setSelectionRange(caret, caret);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
  });
}
async function type(text: string) {
  for (const char of text) { await key(char); await edit(char); }
}
async function paste(text: string) {
  await act(async () => input().dispatchEvent(new Event('paste', { bubbles: true })));
  await edit(text, 'insertFromPaste', null);
}
async function caret(start: number, end = start) {
  await act(async () => {
    input().setSelectionRange(start, end);
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    input().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}
async function backspace() {
  await key('Backspace');
  input().setSelectionRange(input().selectionStart - 1, input().selectionStart);
  await edit('', 'deleteContentBackward', null);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: vi.fn() },
    hidePopover: { configurable: true, value: vi.fn() },
    scrollIntoView: { configurable: true, value: vi.fn() },
  });
  availableSkills.mockReset().mockResolvedValue(options);
  submit.mockReset().mockResolvedValue(false);
  listeners.clear();
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    capabilities: { market: {
      availableSkills,
      observeChanges: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); },
    } },
    modes: { listAvailable: vi.fn().mockResolvedValue([]) },
  } });
  clearAllComposerDrafts();
  workspace = '/workspace/example-main';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearAllComposerDrafts();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => (await testDOM).window.close());

describe.each(['welcome', 'main', 'worker'] as const)('%s skill input', (variant) => {
  beforeEach(async () => { mode = variant; await render(); await act(async () => input().focus()); });

  it.each(['', 'Example ', 'Example\n', 'Example\t', 'Example　'])('opens after direct slash at a whitespace boundary: %j', async (prefix) => {
    await restore(prefix);
    await caret(prefix.length);
    await type('/');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(rows()).toHaveLength(3);
    expect(availableSkills).toHaveBeenCalledWith(workspace);
    expect(rows().map((row) => row.textContent)).toEqual([
      'alphaArrange sample notes个人', 'betaInspect sample tables项目', 'gammaRead sample files系统',
    ]);
  });

  it.each(['Example', 'https:'])('does not open within words or URL prefixes: %s', async (prefix) => {
    await restore(prefix);
    await caret(prefix.length);
    await type('/');
    expect(list()).toBeNull();
    expect(input().value).toBe(`${prefix}/`);
  });

  it('keeps pasted and restored slashes as text until a new slash is typed', async () => {
    await paste('/alpha');
    expect(list()).toBeNull();
    await caret(2);
    await type('b');
    expect(list()).toBeNull();
    await restore('Example /beta');
    await caret(input().value.length);
    expect(list()).toBeNull();
    await type(' /');
    expect(rows()).toHaveLength(3);
    await paste('gamma');
    expect(list()).toBeNull();
    expect(input().value).toBe('Example /beta /gamma');
  });

  it('selects with keyboard or mouse, preserves surrounding text and cursor, and deduplicates tags', async () => {
    await restore('Before  after');
    await caret(7);
    await type('/be');
    expect(rows()).toHaveLength(1);
    expect((await key('Enter')).defaultPrevented).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(input().value).toBe('Before  after');
    expect(input().selectionStart).toBe(7);
    expect(document.activeElement).toBe(input());
    expect(tagNames()).toEqual(['beta']);
    await type('/');
    await key('Tab');
    expect(tagNames()).toEqual(['beta', 'alpha']);
    await type('/beta');
    await act(async () => {
      rows()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      rows()[0]!.click();
    });
    expect(tagNames()).toEqual(['beta', 'alpha']);
    expect(input().selectionStart).toBe(7);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除技能 beta"]')!.click());
    expect(tagNames()).toEqual(['alpha']);
    expect(input().value).toBe('Before  after');
  });

  it('closes on Escape without sending or losing input, and requires a fresh slash to reopen', async () => {
    await type('/al');
    const position = input().selectionStart;
    await key('Escape');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(position);
    await type('pha');
    expect(list()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    await type(' /');
    await key('ArrowUp');
    expect(rows()[2]!.getAttribute('aria-selected')).toBe('true');
    await key('ArrowDown');
    expect(rows()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('updates on deletion and closes when the slash, range, whitespace, or focus ends', async () => {
    await type('/al');
    await backspace();
    await backspace();
    expect(rows()).toHaveLength(3);
    await backspace();
    expect(list()).toBeNull();
    await type('/');
    await type(' ');
    expect(list()).toBeNull();
    await type('/');
    await caret(0);
    expect(list()).toBeNull();
    await caret(input().value.length);
    expect(list()).toBeNull();
    await type(' /');
    await act(async () => input().blur());
    expect(list()).toBeNull();
  });

  it('replaces a selection with a slash and does not open for undo, redo or dropped text', async () => {
    await restore('Before sample after');
    await caret(7, 13);
    await type('/');
    expect(rows()).toHaveLength(3);
    await key('Tab');
    expect(input().value).toBe('Before  after');
    for (const inputType of ['historyUndo', 'historyRedo', 'insertFromDrop']) {
      await restore('');
      await edit('/', inputType, '/');
      expect(list()).toBeNull();
    }
  });

  it('reports empty, unmatched and failed queries and consumes Enter until a choice is available', async () => {
    availableSkills.mockResolvedValueOnce([]);
    await type('/');
    expect(container.textContent).toContain('当前工作区没有可用技能');
    await key('Enter');
    expect(submit).not.toHaveBeenCalled();
    expect((await key('Tab')).defaultPrevented).toBe(false);
    expect(list()).toBeNull();
    await restore('');
    availableSkills.mockRejectedValueOnce(new Error('Example lookup unavailable'));
    await type('/');
    expect(container.textContent).toContain('Example lookup unavailable');
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(rows()).toHaveLength(3);
    await type('zzzz');
    expect(container.textContent).toContain('没有匹配的技能');
    await key('Enter');
    expect(submit).not.toHaveBeenCalled();
    expect(input().value).toBe('/zzzz');
  });

  it('refreshes on reopen and installation changes, and ignores responses from the old workspace', async () => {
    let oldResult!: (value: ComposerSkillOption[]) => void;
    availableSkills.mockReturnValueOnce(new Promise((resolve) => { oldResult = resolve; }));
    await type('/');
    expect(container.textContent).toContain('正在加载技能');
    await key('Enter');
    expect(submit).not.toHaveBeenCalled();
    workspace = '/workspace/example-other';
    await render();
    await restore('');
    await type('/');
    expect(rows()).toHaveLength(3);
    await act(async () => oldResult([{ name: 'old-skill', description: 'Old sample', scope: 'user' }]));
    expect(rows()[0]!.textContent).toContain('alpha');
    availableSkills.mockResolvedValue([{ name: 'new-skill', description: 'New sample', scope: 'project' }]);
    await act(async () => listeners.forEach((callback) => callback()));
    expect(rows()[0]!.textContent).toContain('new-skill');
    await key('Escape');
    await type(' /');
    expect(availableSkills).toHaveBeenLastCalledWith('/workspace/example-other');
    expect(rows()[0]!.textContent).toContain('new-skill');
  });
});

describe('skill search and message drafts', () => {
  it('ranks exact, prefix, name contains and description matches without changing original labels', async () => {
    mode = 'welcome';
    availableSkills.mockResolvedValue([
      { name: 'other', description: 'Contains ALPHA', scope: 'user' },
      { name: 'x-alpha', description: 'Example', scope: 'user' },
      { name: 'alpha-extra', description: 'Example', scope: 'user' },
      { name: 'ALPHA', description: 'Original 描述', scope: 'project' },
      { name: 'other-two', description: 'alpha sample', scope: 'builtin' },
    ]);
    await render();
    await act(async () => input().focus());
    await type('/alpha');
    expect(rows().map((row) => row.querySelector('[class*="name"]')!.textContent)).toEqual([
      'ALPHA', 'alpha-extra', 'x-alpha', 'other', 'other-two',
    ]);
    await key('Escape');
    await restore('');
    await type('/描述');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('Original 描述');
  });

  it.each(['main', 'worker'] as const)('sends a skill-only %s message, restores tags after remount, and retains full failed drafts', async (variant) => {
    mode = variant;
    workspace = variant === 'worker' ? '/workspace/example-worker' : '/workspace/example-main';
    await render();
    await act(async () => input().focus());
    await type('/');
    await key('Enter');
    await act(async () => root.render(null));
    await render();
    expect(tagNames()).toEqual(['alpha']);
    expect(list()).toBeNull();
    const send = () => container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: '', skills: ['alpha'] }));
    expect(tagNames()).toEqual(['alpha']);
    await restore('Sample task');
    await act(async () => useComposerDraftStore.getState().appendFiles(draftKey(), [
      { id: 'file-example', name: 'sample.txt', path: '/workspace/sample.txt' },
    ]));
    await act(async () => send().click());
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'Sample task', skills: ['alpha'], files: [{ name: 'sample.txt', path: '/workspace/sample.txt' }],
    }));
    expect(input().value).toBe('Sample task');
    expect(container.textContent).toContain('sample.txt');
    submit.mockResolvedValue(true);
    await act(async () => send().click());
    expect(input().value).toBe('');
    expect(tagNames()).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[draftKey()]).toBeUndefined();
  });

  it('retains edits made while an earlier message is being accepted', async () => {
    mode = 'main';
    let accepted!: (ok: boolean) => void;
    submit.mockReturnValueOnce(new Promise<boolean>((resolve) => { accepted = resolve; }));
    await render();
    await act(async () => input().focus());
    await type('/');
    await key('Enter');
    await key('Enter');
    await type('Next example');
    await act(async () => accepted(true));
    expect(input().value).toBe('Next example');
    expect(tagNames()).toEqual(['alpha']);
  });

  it('keeps a historical Worker with no known workspace from querying default-workspace skills', async () => {
    mode = 'worker';
    workspace = undefined;
    await render();
    await act(async () => input().focus());
    await type('/');
    expect(list()).toBeNull();
    expect(availableSkills).not.toHaveBeenCalled();
    expect(input().value).toBe('/');
  });

  it('positions a viewport-wide top-layer panel above the transformed anchor, and flips in a short window', async () => {
    mode = 'welcome';
    let anchorTop = 200;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const panel = this.getAttribute('popover') === 'manual';
      return { x: 100, y: anchorTop, left: 100, right: 500, top: anchorTop,
        bottom: anchorTop + 100, width: 400, height: panel ? 120 : 100, toJSON: () => ({}) };
    });
    await render();
    await act(async () => input().focus());
    await type('/');
    const panel = () => container.querySelector<HTMLElement>('[popover="manual"]')!;
    expect(panel().style.width).toBe('400px');
    expect(panel().style.top).toBe('72px');
    expect(panel().style.maxHeight).toBe('184px');
    expect(HTMLElement.prototype.showPopover).toHaveBeenCalled();
    await key('Escape');
    anchorTop = 20;
    await type(' /');
    expect(panel().style.top).toBe('128px');
  });
});
