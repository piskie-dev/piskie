import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentControlState } from '../../../shared/types/agent-control.js';
import type { AgentInputEvent } from '../../../shared/types/index.js';
import type { ToolArtifact } from '../../../shared/types/tool-artifact.js';
import { appLog } from '@electron/observability/logging/app-log.js';
import { ToolCatalog, type FinalToolFace } from '../../tools/catalog.js';
import { z } from '../../tools/params.js';
import type { ToolOutput } from '../../tools/types.js';
import type { ToolActivationContext } from '../tool-call/context-builder.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';
import { AgentEngine } from '../agent-engine.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

vi.mock('@electron/observability/logging/app-log.js', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

class McpLoggingEngine extends AgentEngine {
  constructor(output: ToolOutput<unknown>) {
    super();
    this.id = 'mcp-log-agent';
    this.mainAgentId = this.id;
    this.approvalMode = 'auto';

    const catalog = new ToolCatalog();
    catalog.register(
      {
        def: {
          name: 'mcp__secure__lookup',
          description: 'lookup',
          schema: z.looseObject({}),
          scope: 'shared',
          effects: ['external'],
        },
        execute: async () => output,
      },
      'custom',
      {
        kind: 'mcp',
        server: 'secure',
        tool: 'lookup',
        transport: 'stdio',
        origin: 'global-explicit',
      }
    );
    const face = {
      scope: 'main',
      agentType: 'main',
      customTools: [],
      exposedSkillFunctions: [],
      excluded: new Set<string>(),
      domains: new Set(['local'] as const),
    } satisfies FinalToolFace;
    const activation = {
      agentType: 'main',
      agentSpec: 'director',
      agentId: this.id,
      mainAgentId: this.id,
      runConfig: { name: 'MCP log', description: '', promptTemplate: '' },
      resourceIds: {},
      currentModel: () => 'provider::model',
      workspace: { dir: '/workspace', tempDir: '/tmp/mcp-log-agent' },
      modes: {
        modeId: () => 'normal' as const,
        approvalMode: () => this.approvalMode,
      },
      post: () => true,
    } satisfies ToolActivationContext;
    this.initToolExecution(catalog, face, activation);
  }

  async call(params: Record<string, unknown>): Promise<PendingSettlement> {
    this.pumpController = new AbortController();
    try {
      const result = await this.toolCoordinator.run(
        {
          modelName: 'mcp__secure__lookup',
          rawParams: params,
          callId: 'mcp-call-1',
        },
        this.toolCatalog.snapshot(this.toolFace)
      );
      if (!(result instanceof PendingSettlement)) throw new Error('expected completed MCP call');
      return result;
    } finally {
      this.pumpController = undefined;
    }
  }

  buildSystemPrompt(): string {
    return '';
  }
  getControlState(): AgentControlState {
    return {
      agentId: this.id,
      phase: this.phase,
      interrupted: this.interrupted,
    } as AgentControlState;
  }
  protected override applyEvents(_events: AgentInputEvent[]): void {}
}

describe('AgentEngine MCP tool logging', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([true, false])(
    'does not log high-volume MCP call data while preserving output (ok=%s)',
    async (ok) => {
      const resultSecret = 'result-text-secret';
      const dataSecret = 'structured-data-secret';
      const imageSecret = 'inline-image-secret';
      const artifactSecret = 'artifact-payload-secret';
      const artifact: ToolArtifact = {
        kind: 'mcp_audio',
        payload: { mimeType: 'audio/wav', dataBase64: artifactSecret },
      };
      const output: ToolOutput<unknown> = ok
        ? {
            ok: true,
            text: resultSecret,
            images: [{ base64: imageSecret, mediaType: 'image/png' }],
            data: { access_token: dataSecret },
            artifacts: [artifact],
          }
        : {
            ok: false,
            text: resultSecret,
            data: { access_token: dataSecret },
            artifacts: [artifact],
          };
      const engine = new McpLoggingEngine(output);

      const pending = await engine.call({ query: 'argument-secret' });

      expect(pending.result.text).toBe(resultSecret);
      expect(pending.artifacts).toEqual([artifact]);
      if (ok) expect(pending.result.images?.[0]?.base64).toBe(imageSecret);

      expect(appLog.info).not.toHaveBeenCalled();
      const logs = JSON.stringify({
        debug: vi.mocked(appLog.debug).mock.calls,
        info: vi.mocked(appLog.info).mock.calls,
        warn: vi.mocked(appLog.warn).mock.calls,
        error: vi.mocked(appLog.error).mock.calls,
      });
      for (const secret of [
        resultSecret,
        dataSecret,
        imageSecret,
        artifactSecret,
        'argument-secret',
      ]) {
        expect(logs).not.toContain(secret);
      }
    }
  );
});
