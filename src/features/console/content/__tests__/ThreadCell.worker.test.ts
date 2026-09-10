import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { WorkerNode } from '@/domains/transcript/nodes';
import { resolveStatus, type StatusKey } from '../../data/status';
import type { ThreadCellProps } from '../ThreadCell';
import activeTextStyles from '../activeText.module.css';

vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));

let ThreadCell: typeof import('../ThreadCell').ThreadCell;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ ThreadCell } = await import('../ThreadCell'));
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

function creation(resultText?: string): WorkerNode {
  const entries: ConversationEntry[] = [{
    t: 'msg', ts: 1, id: 'message-example', role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-example', name: 'subagent', input: {
      type: 'explore', subject: 'Inspect the sample', prompt: 'Inspect the example result.',
    } }],
  }];
  if (resultText !== undefined) entries.push({
    t: 'tool', ts: 2, toolUseId: 'call-example', ok: true,
    result: [{ type: 'text', text: resultText }],
  });
  const cell = projectConversationNodes(entries)[0];
  if (cell?.kind !== 'worker') throw new Error('Expected worker creation');
  return cell;
}

const created = () => creation('Worker 已按要求创建: Inspect the sample\nsubagentId: worker-example');
const worker = (status: StatusKey) => ({ id: 'worker-example', subject: 'Inspect the sample', type: 'explore', status });
const row = () => container.querySelector<HTMLElement>('[class*="workerCreation"]');
async function render(props: ThreadCellProps) {
  await act(async () => root.render(createElement(ThreadCell, props)));
}

describe('worker creation row', () => {
  it('animates an executing creation before the result and stops when the conversation becomes inactive', async () => {
    const cell = creation();
    for (const conversationStatus of ['running', 'thinking', 'waiting', 'interrupted', 'stopping', undefined] as const) {
      await render({ cell, conversationStatus, workers: [] });
      expect(row()?.dataset.live).toBe(String(conversationStatus === 'running' || conversationStatus === 'thinking'));
      expect(container.querySelector('button')?.disabled).toBe(true);
      expect(container.querySelector('[data-orb-variant="expanding"]') !== null).toBe(
        conversationStatus === 'running' || conversationStatus === 'thinking',
      );
    }
    expect(row()?.querySelector('svg')?.classList.contains('lucide-search')).toBe(true);
    expect(row()?.textContent).toContain('Inspect the sample');
  });

  it('switches from the creation call to the returned worker status and opens that target', async () => {
    const onOpenWorker = vi.fn();
    await render({ cell: creation(), conversationStatus: 'running', workers: [], onOpenWorker });
    expect(row()?.dataset.live).toBe('true');
    expect(container.querySelector('button')?.disabled).toBe(true);
    const creatingRow = row();
    const creatingOrb = container.querySelector('[data-orb-variant="expanding"]');
    expect(creatingOrb).not.toBeNull();
    const activeText = container.querySelector(`.${activeTextStyles.text}`);
    expect(activeText?.textContent).toContain('Inspect the sample');
    expect(container.querySelectorAll(`.${activeTextStyles.text}`)).toHaveLength(1);

    const cell = created();
    await render({ cell, conversationStatus: 'waiting', workers: [worker('thinking')], onOpenWorker });
    expect(row()?.dataset.live).toBe('true');
    const button = container.querySelector('button');
    expect(button?.type).toBe('button');
    expect(button?.disabled).toBe(false);
    expect(row()).toBe(creatingRow);
    expect(container.querySelector(`.${activeTextStyles.text}`)).toBe(activeText);
    expect(container.querySelector('[data-orb-variant="expanding"]')).toBe(creatingOrb);
    await act(async () => button?.click());
    expect(onOpenWorker).toHaveBeenCalledWith('worker-example');

    for (const status of ['running', 'waiting', 'thinking', 'interrupted', 'stopping'] as const) {
      await render({ cell, conversationStatus: 'running', workers: [worker(status)], onOpenWorker });
      expect(row()?.dataset.live).toBe(String(status === 'running' || status === 'thinking'));
      expect(container.querySelector('button')?.disabled).toBe(false);
      expect(row()).toBe(creatingRow);
      expect(container.querySelectorAll(`.${activeTextStyles.text}`)).toHaveLength(
        status === 'running' || status === 'thinking' ? 1 : 0,
      );
      expect(container.querySelector('[data-orb-variant="expanding"]') !== null).toBe(
        status === 'running' || status === 'thinking',
      );
      expect(container.querySelector('svg.lucide-search') !== null).toBe(
        status !== 'running' && status !== 'thinking',
      );
    }
    await render({ cell, conversationStatus: 'running', workers: [], onOpenWorker });
    expect(row()?.dataset.live).toBe('false');
    expect(container.querySelector('button')?.disabled).toBe(true);
    expect(container.querySelector('[data-orb-variant]')).toBeNull();
    expect(container.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    expect(container.querySelector('svg.lucide-search')).not.toBeNull();
  });

  it('uses the unified interrupted status even when the worker phase is thinking', async () => {
    await render({
      cell: created(), workers: [worker(resolveStatus({ phase: 'thinking', interrupted: true }))],
    });
    expect(row()?.dataset.live).toBe('false');
  });

  it('keeps completed historical rows static without an active target, including old results with no ID', async () => {
    for (const cell of [created(), creation('Worker created: Inspect the sample')]) {
      await render({ cell, conversationStatus: 'running', workers: [], onOpenWorker: vi.fn() });
      expect(row()?.dataset.live).toBe('false');
      expect(container.querySelector('button')?.disabled).toBe(true);
      expect(container.querySelector('[data-orb-variant]')).toBeNull();
      expect(container.querySelector(`.${activeTextStyles.text}`)).toBeNull();
    }
  });
});
