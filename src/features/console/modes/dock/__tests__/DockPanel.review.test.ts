import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockPanel } from '../DockPanel';
import type { PathReviewTarget } from '../../../content/fileReviewTarget';
import type { ReviewSlotProps } from '../../../content/ReviewSlot';
import { deferred } from '../../../attachments/__tests__/fixtures';
import type { FilePreviewDescriptor } from '@shared/electron-contracts/desktop';
import reviewStyles from '../../../content/FileChangesReview.module.css';
import overlayStyles from '../../../chrome/overlay.module.css';

const viewPlan = vi.fn();
const preview = vi.fn<(path: string) => Promise<FilePreviewDescriptor>>();
const reviewInstances: ReviewSlotProps[] = [];
let withTasks = false;
vi.mock('../../../data/vm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../data/vm')>(),
  useAgentVM: (agentId: string) => ({
    agentId, title: 'Sample session', phase: 'waiting', status: 'waiting', pendingEvents: [], workers: [],
    taskBoard: withTasks ? { taskSummary: 'Sample plan', items: [
      { id: 'sample-task', subject: 'Sample task', description: 'Sample detail', status: 'in_progress', owner: agentId, dependsOn: [] },
    ] } : undefined,
  }),
  useWorkerVM: () => null,
}));
vi.mock('../../../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../../../data/useMarkSessionRead', () => ({ useMarkSessionRead: () => undefined }));
vi.mock('../../../data/useTranscript', () => ({ useTranscript: () => ({ nodes: [], loaded: true, hasEarlier: false }) }));
vi.mock('../../../data/useFileChanges', () => ({ useFileChanges: () => ({ totals: { filesChanged: 1, added: 3, removed: 1 } }) }));
vi.mock('../../../data/usePlanDocument', () => ({ usePlanDocument: () => ({ view: viewPlan, close: vi.fn(), open: false }) }));
vi.mock('../../../content/Transcript', () => ({ Transcript: () => null }));
vi.mock('../../../content/AgentMetricsStrip', () => ({ AgentMetricsStrip: () => null }));
vi.mock('../../../content/McpRuntimeCard', () => ({ McpRuntimeCard: () => null }));
vi.mock('../../../content/composer/ConversationComposer', () => ({ ConversationComposer: () => createElement('textarea') }));
vi.mock('../../../content/ReviewSlot', () => ({ ReviewSlot: (props: ReviewSlotProps) => {
  reviewInstances.push(props);
  const { target, onUpdateTarget } = props;
  return createElement('div', {
    'data-review-kind': target?.kind,
    'data-review-path': target?.kind === 'path' ? target.path : undefined,
    'data-preview-kind': target?.kind === 'path' ? target.preview.kind : undefined,
    'data-preview-revision': target?.kind === 'path' ? target.preview.revision : undefined,
  }, target?.kind === 'path' && createElement('button', { onClick: () => onUpdateTarget?.(target, {
    ...target, preview: { ...target.preview, revision: 'revision-two' },
  }) }, 'Refresh sample snapshot'));
} }));
vi.mock('@/components/content-links', () => ({
  ContentLinkUrlScope: ({ children, onOpenLocalFile }: { children: ReactNode; onOpenLocalFile: (path: string) => void }) => createElement('div', null,
    createElement('button', { onClick: () => onOpenLocalFile('/workspace/preview.txt') }, 'Open sample path'),
    createElement('button', { onClick: () => onOpenLocalFile('~/sample folder/.示例目录') }, 'Open sample directory'), children),
  LinkedMarkdown: ({ children }: { children: ReactNode }) => children,
}));

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  };
  Object.assign(dom.window, { piskie: { desktop: { files: { preview } } } });
});
beforeEach(() => {
  withTasks = false;
  viewPlan.mockClear();
  reviewInstances.length = 0;
  preview.mockReset().mockResolvedValue({ kind: 'text', revision: 'revision-one', content: 'Sample preview', size: 14, truncated: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(agentId = 'session-alpha') {
  await act(async () => root.render(createElement(DockPanel, { agentId })));
}
const summary = () => container.querySelector<HTMLButtonElement>('button[aria-label*="个文件已更改"]')!;
const dialog = () => container.querySelector<HTMLDialogElement>('dialog[open]')!;
async function clickLabel(label: string) {
  const found = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label || button.textContent === label)!;
  expect(found).toBeDefined();
  await act(async () => found.click());
}

describe('dock file review entry', () => {
  it('sizes the review host explicitly and passes its Dialog body as the scroll owner', async () => {
    await render();
    await clickLabel('Open sample path');
    const host = dialog();
    const body = host.querySelector<HTMLDivElement>(`.${overlayStyles.dialogBody}`)!;
    expect(host.style.getPropertyValue('--dialog-width')).toBe('880px');
    expect(host.classList.contains(reviewStyles.dialog!)).toBe(true);
    expect(reviewInstances.at(-1)!.scrollContainerRef?.current).toBe(body);
    expect(body.contains(host.querySelector('[data-review-kind]'))).toBe(true);
    await act(async () => summary().click());
    expect(dialog().classList.contains(reviewStyles.dialog!)).toBe(true);
    expect(dialog().querySelector(`.${reviewStyles.dialogBody}`)).toBe(body);
  });

  it('updates the existing dialog target and rejects stale same-path and cross-scope callbacks', async () => {
    await render();
    await clickLabel('Open sample path');
    const initial = reviewInstances.at(-1)!;
    await clickLabel('Refresh sample snapshot');
    const latest = reviewInstances.at(-1)!;
    expect(dialog().querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-two');
    await act(async () => initial.onUpdateTarget!(initial.target as PathReviewTarget, null));
    expect(dialog().querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-two');
    await render('session-beta');
    await clickLabel('Open sample path');
    const otherScope = reviewInstances.at(-1)!;
    await act(async () => latest.onUpdateTarget!(latest.target as PathReviewTarget, null));
    expect(dialog().querySelector('[data-preview-revision]')?.getAttribute('data-preview-revision')).toBe('revision-one');
    await act(async () => otherScope.onUpdateTarget!(otherScope.target as PathReviewTarget, null));
    expect(container.querySelector('dialog[open]')).toBeNull();
  });

  it('rejects a callback from a dismissed dialog after reopening the same path', async () => {
    await render();
    await clickLabel('Open sample path');
    const initial = reviewInstances.at(-1)!;
    await act(async () => dialog().close());
    await clickLabel('Open sample path');
    await act(async () => initial.onUpdateTarget!(initial.target as PathReviewTarget, null));
    expect(container.querySelector('dialog[open]')).not.toBeNull();
  });

  it.each(['scope', 'selection', 'close', 'unmount'] as const)('discards an initial preview that finishes after %s changes', async (action) => {
    await render();
    await clickLabel('Open sample path');
    const pending = deferred<FilePreviewDescriptor>();
    preview.mockReturnValueOnce(pending.promise);
    await clickLabel('Open sample path');
    if (action === 'scope') await render('session-beta');
    else if (action === 'selection') await act(async () => summary().click());
    else if (action === 'close') await act(async () => dialog().close());
    else await act(async () => root.render(null));
    await act(async () => pending.resolve({ kind: 'directory', revision: 'revision-two' }));
    expect(container.querySelector('[data-preview-revision="revision-two"]')).toBeNull();
    if (action === 'selection') expect(dialog().querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('collection');
  });


  it('opens the review dialog for a directory through the shared path entry', async () => {
    preview.mockResolvedValue({ kind: 'directory', revision: 'revision-one' });
    await render();
    expect(container.querySelector('dialog[open]')).toBeNull();
    await clickLabel('Open sample directory');
    expect(preview).toHaveBeenCalledExactlyOnceWith('~/sample folder/.示例目录');
    const review = dialog().querySelector('[data-review-kind]')!;
    expect(review.getAttribute('data-review-kind')).toBe('path');
    expect(review.getAttribute('data-review-path')).toBe('~/sample folder/.示例目录');
    expect(review.getAttribute('data-preview-kind')).toBe('directory');
  });

  it('toggles the collection and reflects native dialog dismissal, path targets and session switches', async () => {
    await render();
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(summary().querySelector('.lucide-chevron-right')).not.toBeNull();
    await act(async () => summary().click());
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(summary().querySelector('.lucide-chevron-left')).not.toBeNull();
    expect(dialog().querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('collection');
    // The native close event is shared by Escape and light dismiss.
    await act(async () => dialog().close());
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    await act(async () => summary().click());
    await clickLabel('Open sample path');
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(dialog().querySelector('[data-review-kind]')?.getAttribute('data-review-kind')).toBe('path');
    await render('session-beta');
    expect(container.querySelector('dialog[open]')).toBeNull();
    expect(summary().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps task collapse, task details and plan access independent of the summary button', async () => {
    withTasks = true;
    await render();
    const taskToggle = container.querySelector<HTMLButtonElement>('section[aria-label="任务清单"] button')!;
    expect(taskToggle.contains(summary())).toBe(false);
    await act(async () => summary().click());
    expect(taskToggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => dialog().close());
    await act(async () => taskToggle.click());
    expect(taskToggle.getAttribute('aria-expanded')).toBe('true');
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    const item = container.querySelector<HTMLButtonElement>('li button')!;
    await act(async () => item.click());
    expect(container.textContent).toContain('Sample detail');
    await clickLabel('查看计划正文');
    expect(viewPlan).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('button[aria-label*="个文件已更改"]')).toHaveLength(1);
  });
});
