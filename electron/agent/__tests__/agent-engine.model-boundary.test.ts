import { describe, expect, it, vi } from 'vitest';
import type { AgentControlState, ConversationEntry } from '../../../shared/types/agent-control.js';
import type { AIResponse, ContentBlock, AgentInputEvent, Message, Tool } from '../../../shared/types/index.js';
import { ToolCatalog, type CatalogEntry, type CatalogSnapshot, type FinalToolFace } from '../../tools/catalog.js';
import { z } from '../../tools/params.js';
import { ToolSearchTool } from '../../tools/skill/tool-search.tool.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';
import { AgentEngine, type TurnOutcome } from '../agent-engine.js';
import { resolveToolUseSettlement } from '../context/conversation-protocol.js';
import { Settler } from '../conversation/settler.js';
import type { ToolActivationContext } from '../tool-call/context-builder.js';
import type { AgentContentEvent } from '../../tools/types.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

let responseSequence = 0;

function aiResponse(content: ContentBlock[], stopReason: 'tool_use' | 'end_turn'): AIResponse {
  const index = ++responseSequence;
  return {
    content,
    requestInfo: {
      version: 1,
      requestId: `request-${index}`,
      runId: `run-${index}`,
      model: 'provider::model',
      stopReason,
      latencyMs: 1,
      usage: {},
    },
  };
}

function mcpEntry(
  name: string,
  options: { exposure?: 'direct' | 'deferred'; onExecute?: () => void } = {},
): CatalogEntry {
  return Object.freeze({
    modelName: name,
    tool: {
      def: {
        name,
        description: name,
        schema: z.looseObject({}),
        scope: 'shared' as const,
        effects: ['external'],
      },
      async execute() {
        options.onExecute?.();
        return { ok: true as const, text: `${name}-ok` };
      },
    },
    trust: 'custom' as const,
    identity: {
      kind: 'mcp' as const,
      server: 'srv',
      tool: name,
      transport: 'stdio' as const,
      origin: 'global-explicit' as const,
    },
    exposure: options.exposure ?? 'direct',
    definitionOverride: {
      name,
      description: name,
      input_schema: { type: 'object' as const, properties: {} },
    },
  });
}

class MiniContext {
  readonly messages: Message[] = [];
  compactBeforeNextRequest = false;

  getAllMessages(): Message[] { return this.messages; }
  flush(): void {}
  async getMessagesForAI(
    _request?: unknown,
    _signal?: AbortSignal,
    onCompactionActivity?: (active: boolean) => void,
  ): Promise<{ messages: Message[] }> {
    if (this.compactBeforeNextRequest) {
      this.compactBeforeNextRequest = false;
      onCompactionActivity?.(true);
      await Promise.resolve();
      onCompactionActivity?.(false);
    }
    return { messages: this.messages };
  }
  addAssistantMessage(content: ContentBlock[]): void {
    this.messages.push({ role: 'assistant', content });
  }
  appendToolResult(callId: string, blocks: unknown[]): void {
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: blocks } as ContentBlock],
    });
  }
}

class BoundaryEngine extends AgentEngine {
  private readonly mini = new MiniContext();
  private projectionEntries: readonly CatalogEntry[] = [mcpEntry('mcp__srv__first')];
  private projectionRevision = 1;
  readonly requests: Array<{ prompt: string; tools: string[] }> = [];
  readonly executions: Array<{
    requested: string;
    firstVisible: boolean;
    lateVisible: boolean;
  }> = [];
  readonly requestPhases: Array<string | undefined> = [];
  readonly contentEvents: AgentContentEvent[] = [];
  boundaryAdvances = 0;

  constructor() {
    super();
    this.id = 'boundary-agent';
    this.mainAgentId = this.id;
    this.context = this.mini as never;
    this.toolCatalog = new ToolCatalog();
    this.toolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    } satisfies FinalToolFace;
    this.settler = new Settler({
      resolve: (callId) => resolveToolUseSettlement(this.mini.messages, callId),
      appendLiveToolResult: (callId, blocks) => this.mini.appendToolResult(callId, blocks),
      appendRecoveryToolResult: (callId, blocks) => this.mini.appendToolResult(callId, blocks),
      appendSystemMessage: vi.fn(),
    }, (callId) => this.recordToolSettled(callId));
    this.toolCoordinator = {
      run: vi.fn(async (raw: { modelName: string; callId: string }, snapshot: CatalogSnapshot) => {
        this.executions.push({
          requested: raw.modelName,
          firstVisible: Boolean(snapshot.resolve('mcp__srv__first')),
          lateVisible: Boolean(snapshot.resolve('mcp__srv__late')),
        });
        return new PendingSettlement(raw.callId, raw.modelName, { ok: true, text: 'done' });
      }),
    } as never;
  }

  protected override async advanceModelBoundary(): Promise<void> {
    this.boundaryAdvances++;
  }

  protected override captureCatalogSnapshot(): CatalogSnapshot {
    return this.toolCatalog.snapshot(this.toolFace, { entries: this.projectionEntries });
  }

  protected override getModelBoundaryRevision(): number {
    return this.projectionRevision;
  }

  buildSystemPrompt(): string {
    return `prompt-r${this.projectionRevision}`;
  }

  protected override async callAI(
    systemPrompt: string,
    tools: Tool[],
  ): Promise<AIResponse> {
    this.requests.push({ prompt: systemPrompt, tools: tools.map((tool) => tool.name) });
    if (this.requests.length === 1) {
      // A server becomes ready while the first request is in flight. It belongs to the next boundary.
      this.projectionEntries = Object.freeze([
        ...this.projectionEntries,
        mcpEntry('mcp__srv__late'),
      ]);
      this.projectionRevision = 2;
      return aiResponse([{
          type: 'tool_use',
          id: 'call-first',
          name: 'mcp__srv__first',
          input: {},
        } as ContentBlock], 'tool_use');
    }
    return aiResponse([{ type: 'text', text: 'finished' } as ContentBlock], 'end_turn');
  }

  async runOneTurn(): Promise<TurnOutcome> {
    return this.runTurn(new AbortController().signal, { executeMode: 'sequential' });
  }

  compactAtNextAdmission(): void {
    this.mini.compactBeforeNextRequest = true;
  }

  override emitStateChange(): void {
    this.requestPhases.push(this.aiRequestState?.phase);
    super.emitStateChange();
  }

  protected override emitContentEvent(event: AgentContentEvent): void {
    this.contentEvents.push(event);
  }

  protected override applyEvents(): void {}
  getControlState(): AgentControlState {
    return { agentId: this.id, phase: this.phase, interrupted: this.interrupted } as AgentControlState;
  }
  protected override appendConversationEntry(_entry: ConversationEntry): void {}
}

class DeferredBoundaryEngine extends AgentEngine {
  private readonly mini = new MiniContext();
  readonly requests: string[][] = [];
  deferredExecutions = 0;

  constructor() {
    super();
    this.id = 'deferred-boundary-agent';
    this.mainAgentId = this.id;
    this.context = this.mini as never;
    this.approvalMode = 'auto';
    this.settler = new Settler({
      resolve: (callId) => resolveToolUseSettlement(this.mini.messages, callId),
      appendLiveToolResult: (callId, blocks) => this.mini.appendToolResult(callId, blocks),
      appendRecoveryToolResult: (callId, blocks) => this.mini.appendToolResult(callId, blocks),
      appendSystemMessage: vi.fn(),
    }, (callId) => this.recordToolSettled(callId));

    const catalog = new ToolCatalog();
    catalog.register(new ToolSearchTool(), 'builtin');
    const face = {
      scope: 'main',
      agentType: 'main',
      customTools: ['tool_search'],
      exposedSkillFunctions: [],
      excluded: new Set<string>(),
      domains: new Set(['local'] as const),
    } satisfies FinalToolFace;
    const activation = {
      agentType: 'main',
      agentSpec: 'director',
      agentId: this.id,
      mainAgentId: this.id,
      runConfig: {
        name: 'Deferred Boundary',
        description: '',
        promptTemplate: '',
      },
      resourceIds: {},
      currentModel: () => 'provider::model',
      workspace: { dir: '/workspace', tempDir: '/tmp/deferred-boundary-agent' },
      modes: { modeId: () => 'normal' as const, approvalMode: () => this.approvalMode },
      post: () => true,
    } satisfies ToolActivationContext;
    this.initToolExecution(catalog, face, activation);
  }

  protected override captureCatalogSnapshot(): CatalogSnapshot {
    return this.toolCatalog.snapshot(this.toolFace, {
      entries: [mcpEntry('mcp__srv__deferred', {
        exposure: 'deferred',
        onExecute: () => { this.deferredExecutions++; },
      })],
    });
  }

  protected override async callAI(
    _systemPrompt: string,
    tools: Tool[],
  ): Promise<AIResponse> {
    this.requests.push(tools.map((tool) => tool.name));
    if (this.requests.length === 1) {
      return aiResponse([
          {
            type: 'tool_use',
            id: 'load-deferred',
            name: 'tool_search',
            input: { query: 'select:mcp__srv__deferred' },
          } as ContentBlock,
          {
            type: 'tool_use',
            id: 'call-deferred-too-early',
            name: 'mcp__srv__deferred',
            input: {},
          } as ContentBlock,
        ], 'tool_use');
    }
    return aiResponse([{ type: 'text', text: 'finished' } as ContentBlock], 'end_turn');
  }

  async runOneTurn(): Promise<TurnOutcome> {
    const controller = new AbortController();
    this.pumpController = controller;
    try {
      return await this.runTurn(controller.signal, { executeMode: 'sequential' });
    } finally {
      this.pumpController = undefined;
    }
  }

  conversationText(): string { return JSON.stringify(this.mini.messages); }

  buildSystemPrompt(): string { return ''; }
  protected override applyEvents(): void {}
  getControlState(): AgentControlState {
    return { agentId: this.id, phase: this.phase, interrupted: this.interrupted } as AgentControlState;
  }
  protected override appendConversationEntry(_entry: ConversationEntry): void {}
}

class GraceMailboxEngine extends AgentEngine {
  private readonly mini = new MiniContext();
  private markGraceEntered!: () => void;
  private releaseGrace!: () => void;
  private firstBoundary = true;
  readonly graceEntered: Promise<void>;
  private readonly graceRelease: Promise<void>;
  readonly appliedBatches: string[][] = [];
  readonly requestEventViews: string[][] = [];

  constructor() {
    super();
    this.id = 'grace-mailbox-agent';
    this.mainAgentId = this.id;
    this.context = this.mini as never;
    this.toolCatalog = new ToolCatalog();
    this.toolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    } satisfies FinalToolFace;
    this.graceEntered = new Promise<void>((resolve) => {
      this.markGraceEntered = resolve;
    });
    this.graceRelease = new Promise<void>((resolve) => {
      this.releaseGrace = resolve;
    });
  }

  get mailboxSize(): number { return this.mailbox.size; }
  unblockGrace(): void { this.releaseGrace(); }

  protected override async advanceModelBoundary(): Promise<void> {
    if (!this.firstBoundary) return;
    this.firstBoundary = false;
    this.markGraceEntered();
    await this.graceRelease;
  }

  protected override async callAI(): Promise<AIResponse> {
    this.requestEventViews.push(this.appliedBatches.flat());
    return aiResponse([{ type: 'text', text: 'finished' } as ContentBlock], 'end_turn');
  }

  protected override applyEvents(events: AgentInputEvent[]): void {
    this.appliedBatches.push(events.map((event) => event.id));
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState {
    return { agentId: this.id, phase: this.phase, interrupted: this.interrupted } as AgentControlState;
  }
  protected override appendConversationEntry(_entry: ConversationEntry): void {}
}

describe('AgentEngine model boundary snapshot', () => {
  it('publishes proactive admission compaction through the same request activity state', async () => {
    const engine = new BoundaryEngine();
    engine.compactAtNextAdmission();

    await engine.runOneTurn();

    const compacting = engine.requestPhases.indexOf('compacting');
    expect(compacting).toBeGreaterThanOrEqual(0);
    expect(engine.requestPhases.slice(compacting + 1)).toContain(undefined);
  });

  it('uses one prompt/catalog/tools revision and delays in-flight MCP arrivals to the next boundary', async () => {
    const engine = new BoundaryEngine();

    await engine.runOneTurn();

    expect(engine.requests).toEqual([
      { prompt: 'prompt-r1', tools: ['mcp__srv__first'] },
      { prompt: 'prompt-r2', tools: ['mcp__srv__first', 'mcp__srv__late'] },
    ]);
    expect(engine.executions).toEqual([{
      requested: 'mcp__srv__first',
      firstVisible: true,
      lateVisible: false,
    }]);
    expect(engine.boundaryAdvances).toBe(2);
    expect(engine.contentEvents).toEqual([{ type: 'assistant_text', content: 'finished' }]);
  });

  it('does not let tool_search authorize a later deferred MCP call from the same AI response', async () => {
    const engine = new DeferredBoundaryEngine();

    await engine.runOneTurn();

    expect(engine.requests).toEqual([
      ['tool_search'],
      ['tool_search', 'mcp__srv__deferred'],
    ]);
    expect(engine.deferredExecutions).toBe(0);
    expect(engine.conversationText()).toContain('schema 尚未装载');
  });

  it('keeps Mailbox events arriving during grace for the next boundary in FIFO order', async () => {
    const engine = new GraceMailboxEngine();
    engine.post({ id: 'initial', source: 'user', content: 'initial' });
    await engine.graceEntered;

    engine.post({ id: 'late-1', source: 'user', content: 'late-1' });
    engine.post({ id: 'late-2', source: 'user', content: 'late-2' });
    expect(engine.isPumping).toBe(true);
    expect(engine.mailboxSize).toBe(2);

    engine.unblockGrace();
    await vi.waitFor(() => {
      expect(engine.requestEventViews).toHaveLength(2);
      expect(engine.isPumping).toBe(false);
    });

    expect(engine.appliedBatches).toEqual([
      ['initial'],
      ['late-1', 'late-2'],
    ]);
    expect(engine.requestEventViews).toEqual([
      ['initial'],
      ['initial', 'late-1', 'late-2'],
    ]);
    expect(engine.mailboxSize).toBe(0);
  });
});
