const testDOM = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'InputEvent', 'KeyboardEvent', 'MouseEvent'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  return dom;
});

import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceGitHead, WorkspaceInfo } from '../../../../../../shared/electron-contracts/desktop';
import { WelcomeComposer } from '../WelcomeComposer';
import { ConversationComposer } from '../ConversationComposer';
import { clearAllComposerDrafts, useComposerDraftStore, WELCOME_DRAFT_KEY } from '../../../data/composer-drafts';

vi.mock('../../../../../components/agent-params/ApprovalModeSelector', () => ({ default: () => null }));
vi.mock('../../../../../components/agent-params/ModeSelector', () => ({ default: () => null }));
vi.mock('../../../../../components/BrowserEnvironmentBindingPicker', () => ({ default: () => null }));
vi.mock('../../../../../components/shared', () => ({ ModelReasoningControl: () => null }));
vi.mock('../ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('../useComposerSettings', () => ({ useComposerSettings: () => ({ modelGroups: [] }) }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));

const info = vi.fn<(workspace?: string) => Promise<WorkspaceInfo>>();
const switchBranch = vi.fn<(workspace: string, branch: string) => Promise<WorkspaceInfo>>();
const createBranch = vi.fn<(workspace: string, branch: string, base: WorkspaceGitHead) => Promise<WorkspaceInfo>>();
const commitId = 'a'.repeat(40);
const chooseFolder = vi.fn();
const useDefault = vi.fn();
let root: Root;
let container: HTMLDivElement;
let workspace: string | undefined;
let head: string;
let branches: string[];
let dirtyFileCount: number;
let variant: 'welcome' | 'main' | 'worker';
const workspaceInfo = (selected = workspace ?? '/sample/default-workspace'): WorkspaceInfo => ({
  path: selected,
  git: { root: selected, head: { kind: 'branch', name: head, commit: commitId }, branches: [...branches], dirtyFileCount },
});

function Harness() {
  if (variant === 'welcome') return createElement(WelcomeComposer, {
    value: '', onChange: vi.fn(), skills: [], onSkillsChange: vi.fn(), draftIdentity: 'sample-welcome',
    onSubmit: vi.fn(), onPaste: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn(), placeholder: 'Sample task', images: [], files: [],
    onRemoveAttachment: vi.fn(), onModelChange: vi.fn(), modeId: 'normal', onModeChange: vi.fn(),
    approvalMode: 'confirm', onApprovalModeChange: vi.fn(), workspacePath: workspace,
    onSelectWorkspace: chooseFolder, onUseDefaultWorkspace: useDefault, environmentIds: [], onEnvironmentIdsChange: vi.fn(),
  });
  return createElement(ConversationComposer, {
    agentId: 'sample-session', workerId: variant === 'worker' ? 'sample-worker' : undefined, workspace,
    targetName: 'Sample target', model: 'example::model', reasoningOverride: { kind: 'provider-default' },
    approvalMode: 'confirm', sourceVersion: 0, canPause: false,
    onSubmit: vi.fn().mockResolvedValue(true), onInterrupt: vi.fn(),
  });
}

const render = async () => { await act(async () => root.render(createElement(Harness))); };
const branchButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="切换分支"]');
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="menuitemradio"]')];
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const menuButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === label)!;
const createEntry = () => menuButton('创建并检出新分支…');
const createSubmit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const createInput = () => container.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!;
const search = (value: string) => inputValue(container.querySelector<HTMLInputElement>('input[type="search"]')!, value);
async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const opened = new WeakSet<HTMLElement>();
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) {
    return selector === ':popover-open' ? opened.has(this) : matches.call(this, selector);
  });
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function () { opened.add(this); } },
    hidePopover: { configurable: true, value: function () { opened.delete(this); } },
  });
  info.mockReset().mockImplementation(async (selected) => workspaceInfo(selected));
  switchBranch.mockReset().mockImplementation(async (selected, branch) => { head = branch; return workspaceInfo(selected); });
  chooseFolder.mockReset(); useDefault.mockReset();
  createBranch.mockReset().mockImplementation(async (selected, branch) => { head = branch; branches.push(branch); return workspaceInfo(selected); });
  head = 'main'; branches = ['feature/sample', 'main']; dirtyFileCount = 3; workspace = '/sample/session-directory'; variant = 'main';
  Object.defineProperty(window, 'piskie', { configurable: true, value: {
    desktop: { workspace: { info, switchBranch, createBranch } },
    capabilities: { market: { availableSkills: vi.fn().mockResolvedValue([]), observeChanges: () => () => undefined } },
    modes: { listAvailable: vi.fn().mockResolvedValue([]) },
  } });
  clearAllComposerDrafts();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); clearAllComposerDrafts();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
afterAll(() => testDOM.window.close());

describe('workspace information in composers', () => {
  it.each(['welcome', 'main', 'worker'] as const)('shows the %s workspace above the input and locks existing session directories', async (mode) => {
    variant = mode;
    useComposerDraftStore.getState().resetDraft(WELCOME_DRAFT_KEY, { workspace: '/sample/another-draft' });
    await render();
    const directory = container.querySelector<HTMLElement>('[title="/sample/session-directory"]')!;
    expect(directory.textContent).toBe('session-directory');
    expect(directory.compareDocumentPosition(container.querySelector('textarea')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(directory.tagName).toBe(mode === 'welcome' ? 'BUTTON' : 'SPAN');
    expect(info).toHaveBeenCalledWith(workspace);
    expect(branchButton()?.textContent).toBe('main');
    if (mode === 'welcome') {
      await click(directory);
      const choose = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === '选择文件夹')!;
      await click(choose); expect(chooseFolder).toHaveBeenCalledOnce();
      await click(directory);
      await click([...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === '使用默认工作区')!);
      expect(useDefault).toHaveBeenCalledOnce();
    } else {
      await click(directory); expect(container.querySelector('[role="menuitem"]')).toBeNull();
    }
  });

  it.each(['welcome', 'main'] as const)('resolves the full default directory for %s', async (mode) => {
    workspace = undefined; variant = mode; await render();
    expect(info).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('[title="/sample/default-workspace"]')?.textContent).toBe(mode === 'welcome' ? '默认工作区' : 'default-workspace');
  });

  it('keeps an older Worker with no recorded directory unknown', async () => {
    variant = 'worker'; workspace = undefined; await render();
    expect(container.textContent).toContain('工作区未知'); expect(info).not.toHaveBeenCalled(); expect(branchButton()).toBeNull();
  });

  it('hides branch controls for a non-Git directory', async () => {
    info.mockResolvedValue({ path: workspace!, git: null }); await render();
    expect(container.querySelector('[title="/sample/session-directory"]')).not.toBeNull(); expect(branchButton()).toBeNull();
  });

  it('refreshes on opening, searches local branches, marks current and displays a successful switch', async () => {
    await render(); await click(branchButton()!);
    expect(info).toHaveBeenCalledTimes(2);
    expect(options()[0]?.getAttribute('title')).toBe('main');
    expect(options()[0]?.textContent).toBe('main未提交：3 个文件');
    expect(options().every((option) => option.querySelector('svg.lucide-git-branch'))).toBe(true);
    expect(options()[0]?.querySelector('svg.lucide-check')).not.toBeNull();
    expect(container.querySelector('mark')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('input[type="search"]'));
    await search('absent'); expect(container.textContent).toContain('没有匹配的分支');
    await search('FEATURE'); expect(options().map((option) => option.textContent)).toEqual(['feature/sample']);
    expect(options()[0]?.querySelector('mark')?.textContent).toBe('feature');
    expect(options()[0]?.title).toBe('feature/sample');
    await click(options()[0]!);
    expect(switchBranch).toHaveBeenCalledWith('/sample/session-directory', 'feature/sample');
    expect(branchButton()?.textContent).toBe('feature/sample'); expect(options()).toHaveLength(0);
  });

  it('honors a selected branch even when Git changes after the menu opens', async () => {
    await render(); await click(branchButton()!);
    const selected = options().find((option) => option.getAttribute('aria-checked') === 'true')!;
    head = 'feature/sample';
    await click(selected);
    expect(switchBranch).toHaveBeenCalledWith('/sample/session-directory', 'main');
    expect(branchButton()?.textContent).toBe('main');
  });

  it('refreshes external changes when the window gains focus or the menu opens', async () => {
    await render(); head = 'feature/sample';
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(branchButton()?.textContent).toBe('feature/sample');
    info.mockResolvedValue({ ...workspaceInfo(), git: { ...workspaceInfo().git!, branches: ['feature/external', 'feature/sample', 'main'] } });
    await click(branchButton()!); expect(options().map((option) => option.textContent)).toContain('feature/external');
  });

  it('reports a refused switch, refreshes the list and allows a retry', async () => {
    switchBranch.mockRejectedValueOnce(new Error('Local changes would be overwritten.'));
    await render(); await click(branchButton()!); await click(options()[1]!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法切换分支：Local changes would be overwritten.');
    expect(branchButton()?.textContent).toBe('main'); expect(branchButton()?.disabled).toBe(false);
    await click(options()[1]!); expect(branchButton()?.textContent).toBe('feature/sample'); expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows read failures without a stale branch and recovers with retry', async () => {
    await render(); info.mockResolvedValueOnce({ path: workspace!, git: null, error: 'Sample directory unavailable' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(branchButton()).toBeNull(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sample directory unavailable');
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === '重试')!);
    expect(branchButton()?.textContent).toBe('main'); expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows detached HEAD and the unborn current branch with its worktree status', async () => {
    info.mockResolvedValue({ path: workspace!, git: { root: workspace!, head: { kind: 'detached', commit: 'abc1234'.padEnd(40, '0') }, branches: ['main'], dirtyFileCount: 0 } });
    await render(); expect(branchButton()?.textContent).toBe('分离 HEAD · abc1234');
    await click(branchButton()!); expect(options()).toHaveLength(1); expect(options()[0]?.getAttribute('aria-checked')).toBe('false');
    await click(options()[0]!); expect(branchButton()?.textContent).toBe('main');
    info.mockResolvedValue({ path: workspace!, git: { root: workspace!, head: { kind: 'unborn', name: 'main' }, branches: [], dirtyFileCount: 1 } });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(branchButton()?.textContent).toBe('main（尚无提交）'); await click(branchButton()!);
    expect(options()).toHaveLength(1); expect(options()[0]?.textContent).toBe('main未提交：1 个文件');
    expect(options()[0]?.disabled).toBe(true); expect(createEntry().disabled).toBe(false);
  });

  it('keeps original casing and text markup literal while highlighting every substring match', async () => {
    branches = ['feature/FeAt-Feat', 'feature/<sample>', 'İssue/Sample', 'main'];
    await render(); await click(branchButton()!); await search('fEaT');
    expect(options().map((option) => option.title)).toEqual(['feature/<sample>', 'feature/FeAt-Feat']);
    expect([...options()[1]!.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['feat', 'FeAt', 'Feat']);
    await search('<sample>');
    expect(options()[0]?.querySelector('mark')?.textContent).toBe('<sample>');
    expect(options()[0]?.querySelector('sample')).toBeNull();
    await search('Sample');
    expect(options().find((option) => option.title === 'İssue/Sample')?.querySelector('mark')?.textContent).toBe('Sample');
    await search('i');
    expect(options().find((option) => option.title === 'İssue/Sample')?.querySelector('mark')?.textContent).toBe('İ');
  });

  it('keeps keyboard navigation and a reachable creation action with no matches', async () => {
    await render(); await click(branchButton()!);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(options()[0]);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(document.activeElement).toBe(options()[1]);
    await search('absent');
    await act(async () => container.querySelector('input[type="search"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(createEntry());
  });

  it('updates dirty counts on focus, menu opening, and successful switching', async () => {
    await render(); await click(branchButton()!);
    dirtyFileCount = 0; await act(async () => window.dispatchEvent(new Event('focus')));
    expect(options()[0]?.textContent).toBe('main工作区干净');
    await click(branchButton()!); dirtyFileCount = 2; await click(branchButton()!);
    expect(options()[0]?.textContent).toBe('main未提交：2 个文件');
    dirtyFileCount = 1; await click(options()[1]!);
    expect(branchButton()?.textContent).toBe('feature/sample');
    await click(branchButton()!); expect(options()[0]?.textContent).toBe('feature/sample未提交：1 个文件');
  });

  it('prefills creation from search, preserves search on return and creates only after submission', async () => {
    await render(); await click(branchButton()!); await search('feature/New'); await click(createEntry());
    expect(createInput().value).toBe('feature/New'); expect(document.activeElement).toBe(createInput());
    expect(container.textContent).toContain('基于 main 创建'); expect(createBranch).not.toHaveBeenCalled();
    await click(menuButton('返回'));
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('feature/New');
    expect(document.activeElement).toBe(container.querySelector('input[type="search"]'));
    await click(createEntry());
    await inputValue(createInput(), '   '); expect(createSubmit().disabled).toBe(true);
    await inputValue(createInput(), 'feature/New'); dirtyFileCount = 2;
    await click(createSubmit());
    expect(createBranch).toHaveBeenCalledExactlyOnceWith('/sample/session-directory', 'feature/New', { kind: 'branch', name: 'main', commit: commitId });
    expect(branchButton()?.textContent).toBe('feature/New');
    expect(options()[0]?.textContent).toBe('feature/New未提交：2 个文件');
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('');
  });

  it('retains the name and concrete creation error, refreshes the base and allows retry', async () => {
    createBranch.mockRejectedValueOnce(new Error('HEAD changed since the form was displayed.'));
    await render(); await click(branchButton()!); await search('feature/new'); await click(createEntry());
    head = 'feature/sample'; await click(createSubmit());
    expect(createInput().value).toBe('feature/new'); expect(createInput().getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法创建分支：HEAD changed');
    expect(container.textContent).toContain('基于 feature/sample 创建');
    await click(createSubmit());
    expect(createBranch).toHaveBeenLastCalledWith('/sample/session-directory', 'feature/new', { kind: 'branch', name: 'feature/sample', commit: commitId });
    expect(branchButton()?.textContent).toBe('feature/new'); expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['detached', 'unborn'] as const)('uses the displayed %s base and preserves the input after a Git refusal', async (kind) => {
    const base: WorkspaceGitHead = kind === 'detached' ? { kind, commit: 'b'.repeat(40) } : { kind, name: 'main' };
    info.mockResolvedValue({ ...workspaceInfo(), git: { ...workspaceInfo().git!, head: base } });
    createBranch.mockRejectedValueOnce(new Error("fatal: a branch named 'feature/sample' already exists"));
    await render(); await click(branchButton()!); await search('feature/sample'); await click(createEntry());
    expect(container.textContent).toContain(kind === 'detached' ? '基于 bbbbbbb 创建' : '基于 main 创建（尚无提交）');
    await click(createSubmit());
    expect(createBranch).toHaveBeenCalledWith('/sample/session-directory', 'feature/sample', base);
    expect(createInput().value).toBe('feature/sample');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already exists');
    await inputValue(createInput(), 'feature/other'); expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('blocks duplicate submissions and focus refresh while creating', async () => {
    let finish!: (value: WorkspaceInfo) => void;
    createBranch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render(); await click(branchButton()!); await search('feature/new'); await click(createEntry());
    await click(createSubmit());
    expect(createSubmit().disabled).toBe(true); expect(createSubmit().textContent).toBe('正在创建…');
    expect(createInput().disabled).toBe(true); expect(menuButton('返回').disabled).toBe(true); expect(branchButton()?.disabled).toBe(true);
    await click(createSubmit()); await act(async () => window.dispatchEvent(new Event('focus')));
    expect(createBranch).toHaveBeenCalledOnce(); expect(info).toHaveBeenCalledTimes(2);
    head = 'feature/new'; branches.push(head);
    await act(async () => finish(workspaceInfo()));
    expect(branchButton()?.disabled).toBe(false); expect(branchButton()?.textContent).toBe('feature/new');
  });

  it('ignores an older info response after creation and a late creation response after changing directories', async () => {
    let readFinish!: (value: WorkspaceInfo) => void;
    let createFinish!: (value: WorkspaceInfo) => void;
    await render(); await click(branchButton()!); await click(createEntry()); await inputValue(createInput(), 'feature/new');
    info.mockReturnValueOnce(new Promise((resolve) => { readFinish = resolve; }));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(createSubmit().disabled).toBe(true);
    // A newer focus read may finish first; its predecessor must stay obsolete.
    await act(async () => window.dispatchEvent(new Event('focus')));
    await click(createSubmit());
    await act(async () => readFinish({ ...workspaceInfo(), git: null }));
    expect(branchButton()?.textContent).toBe('feature/new');
    await click(createEntry()); await inputValue(createInput(), 'feature/later');
    createBranch.mockReturnValueOnce(new Promise((resolve) => { createFinish = resolve; }));
    await click(createSubmit());
    workspace = '/sample/next-directory'; await render();
    await act(async () => createFinish({ path: '/sample/previous-directory', git: { ...workspaceInfo().git!, head: { kind: 'branch', name: 'feature/later', commit: commitId } } }));
    expect(branchButton()?.textContent).toBe('feature/new'); expect(options()).toHaveLength(0);
  });

  it('ignores late reads for a previous directory', async () => {
    let finish!: (value: WorkspaceInfo) => void;
    info.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render(); workspace = '/sample/next-directory'; await render();
    await act(async () => finish({ path: '/sample/previous-directory', git: null }));
    expect(container.querySelector('[title="/sample/next-directory"]')).not.toBeNull();
    expect(container.textContent).not.toContain('previous-directory');
  });

  it('does not apply a late switch result to a different session workspace', async () => {
    let finish!: (value: WorkspaceInfo) => void;
    switchBranch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render(); await click(branchButton()!); await click(options()[0]!); expect(branchButton()?.disabled).toBe(true);
    workspace = '/sample/next-directory'; await render();
    await act(async () => finish({ path: '/sample/previous-directory', git: { ...workspaceInfo().git!, head: { kind: 'branch', name: 'feature/previous', commit: commitId } } }));
    expect(container.querySelector('[title="/sample/next-directory"]')).not.toBeNull(); expect(branchButton()?.textContent).toBe('main');
  });
});
