import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEnvironment } from '@shared/types';
import type { ConversationEntry } from '@shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { useBrowserEnvironmentStore } from '@/store/browserEnvironmentStore';
import { BrowserEnvironmentTags } from '../BrowserEnvironmentTags';
import { ThreadCell } from '../ThreadCell';

vi.mock('@/utils/platform', () => ({ isMacOSPlatform: () => false }));
vi.mock('@/components/content-links', () => ({
  LinkedMarkdown: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  LinkedText: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../StreamingMarkdown', () => ({ StreamingMarkdown: () => null }));

const environments = [
  { id: 'environment-a', name: 'Sample browser A' },
  { id: 'environment-b', name: 'Sample browser B' },
] as BrowserEnvironment[];

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useBrowserEnvironmentStore.setState({ environments: [] });
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

async function history(entries: ConversationEntry[]) {
  const restored = JSON.parse(JSON.stringify(entries)) as ConversationEntry[];
  const nodes = projectConversationNodes(restored);
  await act(async () => root.render(createElement('main', null,
    ...nodes.map((cell) => createElement(ThreadCell, { key: cell.id, cell })),
  )));
}

describe('message browser environment tags', () => {
  it('shows only the environments joined by this persisted message', async () => {
    useBrowserEnvironmentStore.setState({ environments });
    await history([{
      t: 'msg', id: 'sample-joined', ts: 1, role: 'user', subtype: 'user_input',
      content: 'Compare the sample pages',
      metadata: { browserEnvironmentIds: ['environment-a', 'environment-b'] },
    }, {
      t: 'msg', id: 'sample-followup', ts: 2, role: 'user', subtype: 'user_input',
      content: 'Continue checking',
    }]);

    const bubbles = container.querySelectorAll<HTMLElement>('[class*="bubble"]');
    expect(bubbles).toHaveLength(2);
    const joined = bubbles[0]!.querySelector<HTMLElement>('[data-state="joined"]');
    expect(joined?.getAttribute('aria-label')).toBe('已加入浏览器');
    expect(joined?.textContent).toContain('Sample browser A');
    expect(joined?.textContent).toContain('Sample browser B');
    expect(joined?.querySelectorAll('[title]')).toHaveLength(2);
    expect(joined?.querySelector('button')).toBeNull();
    expect(bubbles[1]!.textContent).toBe('Continue checking');
    expect(bubbles[1]!.querySelector('[data-state="joined"]')).toBeNull();
  });

  it('renders a browser-only message and identifies an environment no longer in the list', async () => {
    useBrowserEnvironmentStore.setState({ environments: [environments[0]!] });
    await history([{
      t: 'msg', id: 'sample-only', ts: 1, role: 'user', subtype: 'user_input', content: '',
      metadata: { browserEnvironmentIds: ['environment-a', 'environment-removed'] },
    }]);

    const bubble = container.querySelector<HTMLElement>('[class*="bubble"]');
    expect(bubble?.textContent).toBe('已加入 2 个浏览器Sample browser Aenvironment-removed');
    expect(bubble?.querySelector('button')).toBeNull();
  });

  it('uses the same tag markup for removable draft selections', async () => {
    useBrowserEnvironmentStore.setState({ environments });
    await act(async () => root.render(createElement(BrowserEnvironmentTags, {
      state: 'pending', environmentIds: ['environment-a'], onRemove: vi.fn(),
    })));
    const tags = container.querySelector<HTMLElement>('[data-state="pending"]');
    expect(tags?.textContent).toBe('Sample browser A');
    expect(tags?.querySelector('button')?.getAttribute('aria-label')).toBe('取消加入 Sample browser A');
  });
});
