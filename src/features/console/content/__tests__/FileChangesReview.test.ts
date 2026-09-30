import { JSDOM } from 'jsdom';
import { act, cloneElement, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@shared/types';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { collectFileChanges } from '../../data/fileChanges';
import { call, edit, result, samplePath, user, write } from '../../data/__tests__/fileChanges.fixtures';
import type { FileReviewTarget } from '../fileReviewTarget';
import { ReviewSlot } from '../ReviewSlot';
import { FileChangeSummary } from '../FileChangeSummary';
import { installMenuDom, menuLabels, rightClick, selectMenuItem } from '../../attachments/__tests__/menuTestDom';
import { useToastStore } from '@/features/toasts';

vi.mock('../../chrome/Tooltip', () => ({ Tooltip: ({ children, title }: { children: ReactElement; title: string }) => cloneElement(children, { title } as object) }));
vi.mock('@/components/content-links', () => ({ LinkedMarkdown: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../data/useFileChanges', () => ({
  useFileChanges: () => ({ ...collectFileChanges('main', new Map([['main', projectConversationNodes(entries)]]), false), loading: false, error: null }),
}));
vi.mock('../../data/useTranscript', () => ({ useTranscript: () => ({ nodes: projectConversationNodes(entries) }) }));

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let entries: ConversationEntry[];
const previewFile = vi.fn();
const revision = vi.fn();
const copy = vi.fn();
const openPath = vi.fn();
const revealPath = vi.fn();

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { piskie: { desktop: { files: { preview: previewFile, revision }, system: { openPath, revealPath } } } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
});
beforeEach(() => {
  installMenuDom(dom);
  revision.mockReset().mockResolvedValue('sample-revision');
  copy.mockReset().mockResolvedValue(undefined);
  openPath.mockReset().mockResolvedValue(undefined);
  revealPath.mockReset().mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  entries = [user('first-turn', '<img src=x onerror=alert(1)>'), ...edit('first', 'alpha', 'beta'), ...edit('second', 'beta', 'gamma'),
    user('latest-turn', 'Update the sample.'), ...edit('latest', 'gamma', 'delta'), ...write('other-file', 'other', '/workspace/other.txt')];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  previewFile.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(target: FileReviewTarget = { kind: 'collection' }) {
  await act(async () => root.render(createElement(ReviewSlot, { agentId: 'main', target })));
}
function button(text: string) {
  const element = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  expect(element).toBeDefined();
  return element!;
}
async function selectPath(path: string, index = 0) {
  const element = container.querySelectorAll<HTMLButtonElement>(`nav button[title="${path}"]`)[index];
  expect(element).toBeDefined();
  await act(async () => element!.click());
}
const detail = () => container.querySelector('[class*="detail"]')!;

describe('file change collection review', () => {
  it('right-clicks a file without selecting it and views only the requested changes', async () => {
    await render();
    const path = '/workspace/other.txt';
    const row = container.querySelector(`nav button[title="${path}"]`)!;
    await rightClick(row);
    expect(detail().textContent).toContain('delta');
    expect(menuLabels(container)).toEqual(['查看变更', '复制路径', '在文件管理器中显示']);
    expect(previewFile).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    await selectMenuItem(container, '复制路径');
    expect(copy).toHaveBeenCalledExactlyOnceWith(path);
    await rightClick(row);
    await selectMenuItem(container, '查看变更');
    expect(detail().textContent).toContain('other');
    expect(detail().textContent).not.toContain('delta');
    await rightClick(row);
    await selectMenuItem(container, '在文件管理器中显示');
    expect(revealPath).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('uses current metadata for missing files, keeps their paths copyable, and opens their parent', async () => {
    revision.mockResolvedValue(null);
    await render();
    const row = container.querySelector(`nav button[title="${samplePath}"]`)!;
    await rightClick(row);
    expect(menuLabels(container)).toEqual(['查看变更', '复制路径', '打开所在文件夹']);
    await selectMenuItem(container, '复制路径');
    expect(copy).toHaveBeenCalledExactlyOnceWith(samplePath);
    await rightClick(row);
    await selectMenuItem(container, '打开所在文件夹');
    expect(openPath).toHaveBeenCalledExactlyOnceWith('/workspace');
    expect(revealPath).not.toHaveBeenCalled();
    openPath.mockRejectedValueOnce(new Error('Sample parent is unavailable'));
    await rightClick(row);
    await selectMenuItem(container, '打开所在文件夹');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ tone: 'error', title: expect.stringContaining('Sample parent is unavailable') });
    expect(previewFile).not.toHaveBeenCalled();
  });

  it.each(['read', 'diff'] as const)('reuses the %s header copy source and leaves selected text to the native menu', async (kind) => {
    if (kind === 'read') entries.push(call('read-call', 'read', { file_path: samplePath }), result('read-call', '1\tSample source text'));
    await render({ kind: 'cell', cellId: kind === 'read' ? 'read-call' : 'latest' });
    const panel = container.firstElementChild!;
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制内容"]')!.click());
    const text = copy.mock.calls[0]![0];
    await rightClick(panel);
    await selectMenuItem(container, kind === 'read' ? '复制内容' : '复制差异');
    expect(copy.mock.calls.map(([value]) => value)).toEqual([text, text]);
    expect(text).toBe(kind === 'read' ? 'Sample source text' : '-gamma\n+delta');
    const body = container.querySelector('[class*="lineText"]')!;
    const range = document.createRange();
    range.selectNodeContents(body);
    document.getSelection()!.addRange(range);
    const event = await rightClick(body);
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('defaults to one latest-turn file, expands earlier turns, and retains all old calls for the same path', async () => {
    await render();
    expect(detail().textContent).toContain('delta');
    expect(detail().textContent).not.toContain('alpha');
    expect(container.querySelectorAll('nav button[title]')).toHaveLength(2);
    await act(async () => button('查看更多历史轮次').click());
    expect(container.querySelectorAll(`nav button[title="${samplePath}"]`)).toHaveLength(2);
    await selectPath(samplePath, 1);
    expect(detail().textContent).toContain('alpha');
    expect(detail().textContent).toContain('gamma');
    expect(detail().textContent).not.toContain('delta');
    expect(detail().querySelectorAll('section')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    await act(async () => button('收起历史轮次').click());
    expect(container.querySelectorAll(`nav button[title="${samplePath}"]`)).toHaveLength(1);
    expect(detail().textContent).toContain('alpha');
    expect(previewFile).not.toHaveBeenCalled();
  });

  it('keeps the selected historical file when a new turn or a new call arrives', async () => {
    await render();
    await act(async () => button('查看更多历史轮次').click());
    await selectPath(samplePath, 1);
    entries.push(user('new-turn', 'A later request.'), ...write('new-call', 'epsilon'));
    await render();
    expect(detail().textContent).toContain('alpha');
    expect(detail().textContent).not.toContain('epsilon');
    expect(container.querySelector('nav button[aria-pressed="true"]')?.getAttribute('title')).toBe(samplePath);
    await selectPath('/workspace/other.txt');
    expect(detail().textContent).toContain('other');
    expect(detail().textContent).not.toContain('alpha');
  });

  it('expands file lists independently per turn and keeps full totals and the selected hidden file on collapse', async () => {
    entries = [];
    for (const [id, count] of [['first', 5], ['middle', 7], ['latest', 8]] as const) {
      entries.push(user(`${id}-turn`, `Sample ${id} turn`));
      for (let index = 1; index <= count; index += 1) {
        entries.push(...write(`${id}-${index}`, `Sample ${id} ${index}\nSecond line`, `/workspace/${id}/sample-${index}.txt`));
      }
    }
    const totals = collectFileChanges('main', new Map([['main', projectConversationNodes(entries)]]), false).totals;
    await act(async () => root.render(createElement('div', null,
      createElement(FileChangeSummary, { changes: totals }),
      createElement(ReviewSlot, { agentId: 'main', target: { kind: 'collection' } }),
    )));
    const summary = () => container.querySelector('button[aria-label*="个文件已更改"]')!.textContent;
    const initialTotal = summary();
    expect(initialTotal).toContain('20 个文件已更改');
    expect(initialTotal).toContain('+40');
    const rounds = () => [...container.querySelectorAll('nav > section')];
    const visibleFiles = (index: number) => rounds()[index]!.querySelectorAll('button[title]').length;
    expect(visibleFiles(0)).toBe(5);
    await act(async () => button('查看更多（还有 3 条）').click());
    expect(visibleFiles(0)).toBe(8);
    await selectPath('/workspace/latest/sample-8.txt');
    await act(async () => button('收起列表').click());
    expect(visibleFiles(0)).toBe(5);
    expect(detail().textContent).toContain('Sample latest 8');
    expect(detail().textContent).toContain('Second line');
    await act(async () => button('查看更多历史轮次').click());
    expect(rounds()).toHaveLength(3);
    expect(visibleFiles(1)).toBe(5);
    expect(visibleFiles(2)).toBe(5);
    expect(rounds()[2]!.querySelector('button[aria-expanded]')).toBeNull();
    await act(async () => button('查看更多（还有 2 条）').click());
    expect(visibleFiles(1)).toBe(7);
    expect(visibleFiles(0)).toBe(5);
    await selectPath('/workspace/middle/sample-7.txt');
    await act(async () => button('收起列表').click());
    expect(visibleFiles(1)).toBe(5);
    expect(detail().textContent).toContain('Sample middle 7');
    expect(detail().textContent).toContain('+2');
    expect(summary()).toBe(initialTotal);
  });

  it('preserves each artifact line-number boundary within the selected file', async () => {
    entries = [user('first-turn')];
    for (const [id, line] of [['first-call', 42], ['second-call', 83]] as const) {
      entries.push(call(id, 'edit', { file_path: samplePath, edits: [{ old_string: 'old', new_string: 'new' }] }), {
        ...result(id), artifacts: [{ kind: 'file_diff', payload: { path: samplePath,
          unifiedDiff: `--- a/sample.txt\n+++ b/sample.txt\n@@ -${line},1 +${line},1 @@\n-old\n+new\n`,
          stat: { linesAdded: 0, linesDeleted: 0, linesChanged: 1 },
        } }],
      });
    }
    await render();
    const sections = [...detail().querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    expect(sections.map((section) => [...section.querySelectorAll('[class*="lineNo"]')].map((line) => line.textContent)))
      .toEqual([['42', '42'], ['83', '83']]);
  });

  it('preserves cell, read, and path previews when switching away from the collection', async () => {
    await render();
    await render({ kind: 'cell', cellId: 'latest' });
    expect(container.querySelector('nav')).toBeNull();
    expect(container.textContent).toContain('delta');
    expect(container.textContent).not.toContain('alpha');
    entries.push(call('read-call', 'read', { file_path: samplePath }), result('read-call', '1\tRecorded text'));
    await render({ kind: 'cell', cellId: 'read-call' });
    expect(container.textContent).toContain('Recorded text');
    await render({ kind: 'path', path: '/workspace/preview.txt', preview: { kind: 'text', revision: 'sample-revision', content: 'Current preview.', truncated: false, size: 16 } });
    expect(container.textContent).toContain('Current preview.');
    expect(container.querySelector('nav')).toBeNull();
  });
});
