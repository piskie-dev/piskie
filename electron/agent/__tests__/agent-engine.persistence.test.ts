import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentControlState,
  ConversationAppendMetadata,
  ConversationEntry,
  ConversationWriteEntry,
} from '../../../shared/types/agent-control.js';
import type { AgentLiveContentDelta } from '../../../shared/electron-contracts/agents.js';
import type { AIResponse, AgentInputEvent, ContentBlock, Message } from '../../../shared/types/index.js';
import { ConversationStore } from '../../agent-runs/conversation-store.js';
import type { AgentContentEvent } from '../../tools/types.js';
import { ToolCatalog, type FinalToolFace } from '../../tools/catalog.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { AgentEngine, type TurnOutcome } from '../agent-engine.js';
import { ContextSettlementConversation, Settler } from '../conversation/settler.js';
import { AgentConversationContext } from '../context/agent-conversation-context.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

const CANONICAL_CONTENT: ContentBlock[] = [
  { type: 'thinking', thinking: 'Inspect first.', protocol: 'openai-chat' },
  { type: 'text', text: 'Final answer.' },
];

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

async function createConversationStore(): Promise<ConversationStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-engine-persistence-'));
  tempRoots.push(root);
  return new ConversationStore(root);
}

function response(content: ContentBlock[], index: number): AIResponse {
  return {
    content,
    requestInfo: {
      version: 1,
      requestId: `ordered-request-${index}`,
      runId: `ordered-run-${index}`,
      model: 'provider::model',
      stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      latencyMs: 1,
      usage: {},
    },
  };
}

function toolUse(id: string, name: string): ContentBlock {
  return { type: 'tool_use', id, name, input: {} } as ContentBlock;
}

class PersistenceEngine extends AgentEngine {
  readonly appends: Array<{
    entry: ConversationEntry;
    metadata?: ConversationAppendMetadata;
  }> = [];
  readonly contentEvents: AgentContentEvent[] = [];
  readonly liveDeltas: AgentLiveContentDelta[] = [];

  constructor() {
    super();
    this.id = 'persistence-agent';
    this.mainAgentId = this.id;
    this.currentModel = 'provider::model';
    this.currentTarget = { providerId: 'provider', modelId: 'model' };
    this.reasoningOverride = { kind: 'provider-default' };
    this.incidentTarget = { agentId: this.id };
    this.inference = fakeAgentInference({
      invoke: async (_request, options) => {
        options.onVisibleDelta?.({
          runId: 'canonical-run',
          attempt: 1,
          sequence: 1,
          kind: 'text',
          delta: 'Discarded draft.',
        });
        options.onVisibleDelta?.({
          runId: 'canonical-run',
          attempt: 2,
          sequence: 2,
          kind: 'think',
          delta: 'Inspect first.',
        });
        options.onVisibleDelta?.({
          runId: 'canonical-run',
          attempt: 2,
          sequence: 3,
          kind: 'text',
          delta: 'Final answer.',
        });
        return {
          content: CANONICAL_CONTENT,
          requestInfo: {
            version: 1,
            requestId: options.requestId,
            runId: 'canonical-run',
            model: 'provider::model',
            stopReason: 'end_turn',
            latencyMs: 80,
            firstVisibleContentLatencyMs: 20,
            generationDurationMs: 60,
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        };
      },
    });
    this.context = new AgentConversationContext({
      inference: this.inference,
      target: this.currentTarget,
      mainAgentId: this.id,
    });
    this.context.setPersistHook((entry, metadata) => this.appends.push({
      entry,
      ...(metadata && { metadata }),
    }));
    this.toolCatalog = new ToolCatalog();
    this.toolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    } satisfies FinalToolFace;
  }

  addUserQuestion(): void {
    this.context.addUserMessage('Question');
  }

  runOneTurn(): Promise<TurnOutcome> {
    return this.runTurn(new AbortController().signal);
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  protected override emitContentEvent(event: AgentContentEvent): void { this.contentEvents.push(event); }
  protected override emitLiveContent(event: AgentLiveContentDelta): void { this.liveDeltas.push(event); }
}

class OrderedPersistenceEngine extends AgentEngine {
  readonly runTool = vi.fn(async (raw: { callId: string; modelName: string }) =>
    new PendingSettlement(raw.callId, raw.modelName, { ok: true, text: 'tool completed' })
  );
  private responseIndex = 0;

  constructor(
    private readonly store: ConversationStore,
    private readonly responses: ContentBlock[][],
    options: {
      beforeResponse?: (index: number) => void;
      failAssistantWrite?: boolean;
    } = {},
  ) {
    super();
    this.id = 'ordered-persistence-agent';
    this.mainAgentId = this.id;
    this.currentModel = 'provider::model';
    this.currentTarget = { providerId: 'provider', modelId: 'model' };
    this.reasoningOverride = { kind: 'provider-default' };
    this.incidentTarget = { agentId: this.id };
    this.inference = fakeAgentInference();
    this.conversationStore = store;
    this.context = new AgentConversationContext({
      inference: this.inference,
      target: this.currentTarget,
      mainAgentId: this.id,
    });
    this.context.setPersistHook((entry, metadata) => {
      if (options.failAssistantWrite && entry.t === 'msg' && entry.role === 'assistant') {
        throw new Error('assistant write failed');
      }
      this.store.append(this.id, this.id, entry, metadata);
    });
    this.settler = new Settler(
      new ContextSettlementConversation(this.context, (entry) => {
        this.store.append(this.id, this.id, entry);
      }),
      (callId) => this.recordToolSettled(callId),
    );
    this.toolCatalog = new ToolCatalog();
    this.toolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    } satisfies FinalToolFace;
    this.toolCoordinator = { run: this.runTool } as never;
    this.beforeResponse = options.beforeResponse;
  }

  private readonly beforeResponse?: (index: number) => void;

  addUserQuestion(): void {
    this.context.addUserMessage('Question');
  }

  messages(): Message[] {
    return this.context.getAllMessages();
  }

  entries(): ConversationEntry[] {
    return this.store.read(this.id, this.id);
  }

  runOneTurn(signal: AbortSignal = new AbortController().signal): Promise<TurnOutcome> {
    return this.runTurn(signal);
  }

  protected override async callAI(): Promise<AIResponse> {
    const index = this.responseIndex++;
    this.beforeResponse?.(index);
    return response(
      this.responses[index] ?? [{ type: 'text', text: 'done' } as ContentBlock],
      index,
    );
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  protected override appendConversationEntry(
    entry: ConversationWriteEntry,
    metadata?: ConversationAppendMetadata,
  ): void {
    this.store.append(this.id, this.id, entry, metadata);
  }
}

describe('AgentEngine canonical response persistence', () => {
  it('persists only canonical messages and emits request correlation as append metadata', async () => {
    const engine = new PersistenceEngine();
    engine.addUserQuestion();

    await engine.runOneTurn();

    const assistant = engine.appends.find(({ entry }) =>
      entry.t === 'msg' && entry.role === 'assistant'
    );
    expect(assistant).toBeDefined();
    expect(assistant?.entry).toMatchObject({
      role: 'assistant',
      content: CANONICAL_CONTENT,
    });
    expect(assistant?.metadata?.requestId).toMatch(/^turn-/);
    const serializedEntries = JSON.stringify(engine.appends.map(({ entry }) => entry));
    expect(serializedEntries).not.toMatch(/"(?:requestId|requestInfo|delta|partial|assistant_text)"/);
    expect(serializedEntries).not.toContain('Discarded draft.');

    const requestId = assistant!.metadata!.requestId!;
    expect(engine.liveDeltas).toEqual([
      {
        agentId: 'persistence-agent',
        requestId,
        runId: 'canonical-run',
        attempt: 1,
        sequence: 1,
        kind: 'text',
        delta: 'Discarded draft.',
      },
      {
        agentId: 'persistence-agent',
        requestId,
        runId: 'canonical-run',
        attempt: 2,
        sequence: 2,
        kind: 'think',
        delta: 'Inspect first.',
      },
      {
        agentId: 'persistence-agent',
        requestId,
        runId: 'canonical-run',
        attempt: 2,
        sequence: 3,
        kind: 'text',
        delta: 'Final answer.',
      },
    ]);
    expect(engine.contentEvents).toEqual([
      { type: 'assistant_text', content: 'Final answer.' },
    ]);
  });
});

describe('AgentEngine durable tool-call ordering', () => {
  it('writes an exclusive mixed batch as assistant then one ToolEntry per call', async () => {
    const engine = new OrderedPersistenceEngine(await createConversationStore(), [
      [toolUse('read-call', 'task_read'), toolUse('event-call', 'send_event')],
      [{ type: 'text', text: 'retried' } as ContentBlock],
    ]);
    engine.addUserQuestion();

    await engine.runOneTurn();

    expect(engine.entries().map((entry) => {
      if (entry.t === 'tool') return `tool:${entry.toolUseId}`;
      if (entry.t === 'msg') return `msg:${entry.role}`;
      return entry.t;
    })).toEqual([
      'msg:user',
      'msg:assistant',
      'tool:read-call',
      'tool:event-call',
      'msg:assistant',
    ]);
    expect(engine.runTool).not.toHaveBeenCalled();
  });

  it('writes an aborted completed response before its not-started ToolEntry', async () => {
    const controller = new AbortController();
    const engine = new OrderedPersistenceEngine(
      await createConversationStore(),
      [[toolUse('aborted-call', 'shell')]],
      { beforeResponse: () => controller.abort(new Error('user interrupted')) },
    );
    engine.addUserQuestion();

    await expect(engine.runOneTurn(controller.signal)).rejects.toThrow('user interrupted');

    expect(engine.entries().map((entry) => {
      if (entry.t === 'tool') return `tool:${entry.toolUseId}`;
      if (entry.t === 'msg') return `msg:${entry.role}`;
      return entry.t;
    })).toEqual([
      'msg:user',
      'msg:assistant',
      'tool:aborted-call',
    ]);
    expect(engine.runTool).not.toHaveBeenCalled();
  });

  it('does not execute or expose a tool call when the assistant write fails', async () => {
    const engine = new OrderedPersistenceEngine(
      await createConversationStore(),
      [[toolUse('unwritten-call', 'shell')]],
      { failAssistantWrite: true },
    );
    engine.addUserQuestion();

    await expect(engine.runOneTurn()).rejects.toThrow('assistant write failed');

    expect(engine.entries()).toEqual([
      expect.objectContaining({ t: 'msg', role: 'user', content: 'Question' }),
    ]);
    expect(engine.messages()).toEqual([
      expect.objectContaining({ role: 'user', content: 'Question' }),
    ]);
    expect(engine.runTool).not.toHaveBeenCalled();
  });
});
