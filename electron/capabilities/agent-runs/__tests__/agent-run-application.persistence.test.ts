import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRunHeader } from '../../../../shared/types/agent-control.js';
import { ConversationStore } from '../../../agent-runs/conversation-store.js';
import { AgentRunApplication } from '../agent-run-application.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-agent-run-application-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AgentRunApplication disk history', () => {
  it('rebuilds the same sorted Main history from a new store instance', () => {
    const firstStore = new ConversationStore(root);
    firstStore.writeHeader('main-old', header('main-old', '2026-08-19T00:00:00.000Z'));
    firstStore.writeHeader('main-new', header('main-new', '2026-08-19T02:00:00.000Z'));
    writeNestedWorkerHeader(firstStore, 'main-new', header(
      'worker-1',
      '2026-08-19T03:00:00.000Z',
    ));

    const first = application(firstStore).list();
    const second = application(new ConversationStore(root)).list();

    expect(first.map(({ agentId }) => agentId)).toEqual(['main-new', 'main-old']);
    expect(second).toEqual(first);
    expect(second.map(({ agentId }) => agentId)).not.toContain('worker-1');
  });

  it('returns isolated Header projections and ignores legacy Flow Headers', () => {
    const store = new ConversationStore(root);
    const current = header('main-1', '2026-08-19T00:00:00.000Z');
    writeJson(path.join(root, 'agent-runs', 'main-1', 'header.json'), {
      ...current,
      retiredHeaderField: 'ignored',
      runConfig: { ...current.runConfig, retiredRunField: 'ignored' },
    });
    writeJson(path.join(root, 'agent-runs', 'legacy', 'header.json'), {
      agentId: 'legacy',
      agentSpec: 'director',
      modeId: 'normal',
      flowConfig: { name: 'Legacy' },
      createdAt: '2026-08-18T00:00:00.000Z',
      lastActiveAt: '2026-08-18T00:00:00.000Z',
      currentModel: 'provider::model',
      approvalMode: 'confirm',
      childAgents: [],
    });
    writeJson(path.join(root, 'agent-runs', 'malformed', 'header.json'), {
      ...header('malformed', '2026-08-18T00:00:00.000Z'),
      runConfig: {},
    });

    const runs = application(store).list();
    runs[0]!.runConfig.name = 'changed by Renderer';

    expect(runs.map(({ agentId }) => agentId)).toEqual(['main-1']);
    expect(runs[0]).not.toHaveProperty('retiredHeaderField');
    expect(runs[0]!.runConfig).not.toHaveProperty('retiredRunField');
    expect(application(store).list()[0]!.runConfig.name).toBe('Run main-1');
  });
});

function application(store: ConversationStore): AgentRunApplication {
  return new AgentRunApplication({
    agent: { getConversationStore: () => store },
    plans: {},
    compactions: {},
    messaging: { removeAgentBindings: async () => undefined },
  } as never);
}

function header(agentId: string, lastActiveAt: string): AgentRunHeader {
  return {
    agentId,
    agentSpec: 'director',
    modeId: 'normal',
    approvalMode: 'confirm',
    runConfig: {
      name: `Run ${agentId}`,
      description: `Description ${agentId}`,
      promptTemplate: `Prompt ${agentId}`,
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    lastActiveAt,
    currentModel: 'provider::model',
    childAgents: [],
  };
}

function writeNestedWorkerHeader(
  store: ConversationStore,
  mainAgentId: string,
  value: AgentRunHeader,
): void {
  writeJson(path.join(store.getOwnerDir(mainAgentId, value.agentId), 'header.json'), value);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}
