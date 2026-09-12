import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationEntry } from '../../../../shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import type { AgentVM, WorkerVM } from '../data/vm';
import { ThreadView } from '../modes/thread/ThreadView';
import { DockPanel } from '../modes/dock/DockPanel';

vi.mock('../data/vm', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/vm')>(),
  useAgentVM: () => main,
  useWorkerVM: (_agentId: string | undefined, workerId?: string) => workerId ? worker : null,
}));
vi.mock('../data/actions', () => ({ useConsoleActions: () => ({}) }));
vi.mock('../data/useMarkSessionRead', () => ({ useMarkSessionRead: () => undefined }));
vi.mock('../data/useTranscript', () => ({
  useTranscript: (agentId: string) => ({
    nodes: nodesByAgent.get(agentId) ?? [],
    loaded: true,
    hasEarlier: false,
  }),
}));
vi.mock('../content/Transcript', () => ({ Transcript: () => null }));
vi.mock('../content/McpRuntimeCard', () => ({ McpRuntimeCard: () => null }));
vi.mock('../content/composer/ConversationComposer', () => ({
  ConversationComposer: () => createElement('textarea', { 'aria-label': 'Message' }),
}));
vi.mock('@/components/content-links', () => ({
  ContentLinkUrlScope: ({ children }: { children: ReactNode }) => children,
  LinkedMarkdown: ({ children }: { children: ReactNode }) => children,
}));

let main: AgentVM = {
  agentId: 'session-main',
  title: 'Example session',
  phase: 'waiting',
  status: 'waiting',
  interrupted: false,
  canPause: false,
  canStop: true,
  model: 'provider::model',
  reasoningOverride: { kind: 'provider-default' },
  approvalMode: 'auto',
  modeId: 'normal',
  createdAt: '2026-01-01T00:00:00.000Z',
  conversationLength: 0,
  runMetrics: {
    version: 1,
    rounds: 0,
    steps: 0,
    llmDurationMs: 0,
    toolDurationMs: 0,
    firstVisibleContentLatencyTotalMs: 0,
    firstVisibleContentSamples: 0,
    generationDurationMs: 0,
    generationOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    coverage: {
      toolTiming: 'none',
      firstVisibleContent: 'none',
      throughput: 'none',
      inputTokens: 'none',
      outputTokens: 'none',
      cacheReadTokens: 'none',
    },
  },
  pendingEvents: [],
  workers: [],
  imageNodeIds: [],
};

let worker: WorkerVM = {
  ...main,
  id: 'session-worker',
  mainAgentId: main.agentId,
  subject: 'Example worker',
  type: 'local-worker',
  taskIds: [],
  browserReady: false,
};

const nodesByAgent = new Map<string, readonly TranscriptNode[]>();

function writes(paths: readonly string[]): TranscriptNode[] {
  const entries = paths.flatMap((path, index): ConversationEntry[] => [
    {
      t: 'msg', id: `message-${index}`, ts: index * 2, role: 'assistant',
      content: [{ type: 'tool_use', id: `call-${index}`, name: 'write', input: { file_path: path, content: 'one\ntwo' } }],
    },
    { t: 'tool', toolUseId: `call-${index}`, ts: index * 2 + 1, ok: true, result: [] },
  ]);
  return projectConversationNodes(entries);
}

beforeEach(() => {
  main = { ...main, taskBoard: undefined };
  worker = { ...worker, taskIds: [] };
  nodesByAgent.clear();
  nodesByAgent.set(main.agentId, writes(['/workspace/sample.txt', '/workspace/another.txt']));
  nodesByAgent.set(worker.id, writes(['/workspace/worker.txt']));
});

const views: Array<[string, ComponentType<{ agentId: string; workerId?: string }>]> = [
  ['thread', ThreadView],
  ['dock', DockPanel],
];

describe.each(views)('%s file change summary', (_name, View) => {
  const render = (workerId?: string) => renderToStaticMarkup(createElement(View, {
    agentId: main.agentId,
    workerId,
  }));

  it('shows main changes above the composer without a task list and retains zero deletions', () => {
    const html = render();

    expect(html).toContain('2 个文件已更改');
    expect(html).toContain('>+4</span>');
    expect(html).toContain('>-0</span>');
    expect(html.indexOf('2 个文件已更改')).toBeLessThan(html.indexOf('<textarea'));
  });

  it('shows the worker summary when the task list only belongs to main', () => {
    main = {
      ...main,
      taskBoard: {
        taskSummary: 'Example plan',
        items: [{ id: 'task-main', subject: 'Example task', description: '', status: 'in_progress', owner: main.agentId, dependsOn: [] }],
      },
    };
    const html = render(worker.id);

    expect(html).not.toContain('aria-label="任务清单"');
    expect(html).toContain('1 个文件已更改');
    expect(html).toContain('>+2</span>');
    expect(html.indexOf('1 个文件已更改')).toBeLessThan(html.indexOf('<textarea'));
  });

  it.each(['main', 'worker'] as const)('shows %s changes in the task list without a separate summary', (scope) => {
    const workerId = scope === 'worker' ? worker.id : undefined;
    main = {
      ...main,
      taskBoard: {
        taskSummary: 'Example plan',
        items: [{ id: 'task-one', subject: 'Example task', description: '', status: 'in_progress', owner: workerId ?? main.agentId, dependsOn: [] }],
      },
    };
    worker = { ...worker, taskIds: workerId ? ['task-one'] : [] };

    const html = render(workerId);

    expect(html).toContain('aria-label="任务清单"');
    expect(html).toContain(workerId ? '>+2</span>' : '>+4</span>');
    expect(html).not.toContain('个文件已更改');
  });

  it('hides the summary for a conversation without file changes', () => {
    nodesByAgent.set(main.agentId, []);

    expect(render()).not.toContain('个文件已更改');
  });
});
