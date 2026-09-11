import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConversationStore } from '../../../agent-runs/conversation-store.js';
import { AgentRunApplication } from '../agent-run-application.js';
import { createAgentRunController } from '../agent-run-controller.js';
import { createElectronPiskieClient } from '../../../transport/electron/piskie-client.js';
import type { ElectronPreloadClient } from '../../../transport/electron/preload-client.js';
import type { AgentRunHeader } from '../../../../shared/types/agent-control.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-messages-'));
  roots.push(root);
  const store = new ConversationStore(root);
  const header: AgentRunHeader = {
    agentId: 'sample-main', agentSpec: 'director', modeId: 'normal',
    runConfig: { name: 'Example', description: 'Example', promptTemplate: '' },
    createdAt: '2025-01-01T00:00:00Z', lastActiveAt: '2025-01-01T00:00:00Z',
    currentModel: 'example/model', approvalMode: 'auto', childAgents: [],
  };
  store.writeHeader(header.agentId, header);
  const application = new AgentRunApplication({ agent: { getConversationStore: () => store } } as never);
  const operations = createAgentRunController(application);
  const request = vi.fn(async (id: string, input: unknown[]) => {
    const operation = operations.find((item) => item.id === id)!;
    return operation.execute({} as never, operation.input.parse(input));
  });
  const client = createElectronPiskieClient({ transport: { request } as unknown as ElectronPreloadClient, version: 'example', platform: 'linux' });
  return { store, client, request, operations };
}

describe('AgentRun message desktop boundary', () => {
  it('lists durable main summaries and acknowledges the exact visible position through the client and controller', async () => {
    const { store, client, request } = setup();
    store.append('sample-main', 'sample-main', { t: 'msg', role: 'assistant', id: 'reply', ts: 1000, content: 'Example reply' });
    const runs = await client.agentRuns.list();
    expect(runs[0].messages).toEqual({ latestMessage: { index: 0, timestamp: 1000 }, latestAssistantIndex: 0, readThroughIndex: -1 });
    await expect(client.agentRuns.markRead('sample-main', 0)).resolves.toMatchObject({ readThroughIndex: 0 });
    expect(request).toHaveBeenLastCalledWith('agent-runs.markRead', ['sample-main', 0]);
    expect((await client.agentRuns.list())[0].messages.readThroughIndex).toBe(0);
  });

  it('accepts only a main run and a nonnegative integral read position at the public boundary', async () => {
    const { store, client, operations } = setup();
    store.append('sample-main', 'sample-worker', { t: 'msg', role: 'assistant', id: 'worker-reply', ts: 1000, content: 'Example worker reply' });
    await expect(client.agentRuns.markRead('sample-worker', 0)).rejects.toThrow('AgentRun was not found');
    const schema = operations.find((operation) => operation.id === 'agent-runs.markRead')!.input;
    expect(schema.safeParse(['sample-main', 0]).success).toBe(true);
    for (const input of [['sample-main', -1], ['sample-main', 0.5], ['sample-main', 0, true]]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });
});
