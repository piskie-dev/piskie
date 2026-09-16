import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@shared/types';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { collectFileChanges } from '../../data/fileChanges';
import { call, edit, result, samplePath, user, write } from '../../data/__tests__/fileChanges.fixtures';
import type { FileReviewTarget } from '../fileReviewTarget';
import { ReviewSlot } from '../ReviewSlot';
import { FileChangeSummary } from '../FileChangeSummary';

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

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { piskie: { desktop: { files: { preview: previewFile }, system: { openPath: vi.fn(), revealPath: vi.fn() } } } });
});
beforeEach(() => {
  entries = [user('first-turn', '<img src=x onerror=alert(1)>'), ...edit('first', 'alpha', 'beta'), ...edit('second', 'beta', 'gamma'),
    user('latest-turn', 'Update the sample.'), ...edit('latest', 'gamma', 'delta'), ...write('other-file', 'other', '/workspace/other.txt')];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  previewFile.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
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
    await render({ kind: 'path', path: '/workspace/preview.txt', preview: { kind: 'text', content: 'Current preview.', truncated: false, size: 16 } });
    expect(container.textContent).toContain('Current preview.');
    expect(container.querySelector('nav')).toBeNull();
  });
});
