import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../conversation-store.js';
import type { AgentRunHeader } from '../../../shared/types/agent-control.js';

let root: string;
let store: ConversationStore;
const header = (): AgentRunHeader => ({
  agentId: 'main-a', agentSpec: 'director', modeId: 'normal',
  runConfig: { name: 'Sample run', description: '', promptTemplate: '' },
  createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z',
  currentModel: 'provider::model', approvalMode: 'auto',
  childAgents: [{ id: 'worker-a', createdAt: 1, config: { type: 'local-worker', subject: 'Sample task', prompt: 'Complete the sample task.' } }],
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-worker-records-'));
  store = new ConversationStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Worker creation records and config boundaries', () => {
  it('reads old child config fields permissively and resaves only the current config', () => {
    const old = header();
    Object.assign(old.childAgents[0]!.config, { taskIds: ['sample-task'], unknown: true });
    const file = store.paths.headerPath('main-a');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(old));
    const restored = store.readHeader('main-a');
    expect(restored).toEqual(header());
    store.writeHeader('main-a', restored!);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(header());
  });

  it.each(['taskIds', 'unknown'])('rejects new writes of schema-external child field %s', (field) => {
    store.writeHeader('main-a', header());
    const invalid = header();
    Object.assign(invalid.childAgents[0]!.config, { [field]: ['sample-task'] });
    expect(() => store.writeHeader('main-a', invalid)).toThrow();
    expect(store.readHeader('main-a')).toEqual(header());
  });

  it('selects only runtime creation markers from the requested Main history', () => {
    store.append('main-a', 'main-a', { t: 'marker', ts: 1, key: 'child_created', value: { id: 'worker-a' } });
    store.append('main-a', 'main-a', { t: 'marker', ts: 2, key: 'child_stopped', value: { id: 'worker-a' } });
    store.append('main-a', 'main-a', { t: 'msg', ts: 3, id: 'sample-message', role: 'user', content: 'child_created worker-fictional' });
    store.append('main-a', 'worker-a', { t: 'marker', ts: 4, key: 'child_created', value: { id: 'worker-nested' } });
    store.append('main-b', 'main-b', { t: 'marker', ts: 5, key: 'child_created', value: { id: 'worker-b' } });
    expect(new ConversationStore(root).readCreatedWorkerIds('main-a')).toEqual(['worker-a']);
    expect(store.readCreatedWorkerIds('main-b')).toEqual(['worker-b']);
  });
});
