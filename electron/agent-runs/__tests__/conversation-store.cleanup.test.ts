import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConversationStore } from '../conversation-store.js';

const mainAgentId = 'main-1';
const workerId = 'worker-1';
let root = '';
let store: ConversationStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-conversation-cleanup-'));
  store = new ConversationStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedOwner(ownerMainId: string, agentId: string): void {
  const directory = store.getOwnerDir(ownerMainId, agentId);
  fs.mkdirSync(path.join(directory, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'conversation.jsonl'), '');
  fs.writeFileSync(path.join(directory, 'blobs', 'artifact.bin'), 'x');
}

describe('ConversationStore ownership cleanup', () => {
  it('deletes one Worker owner without deleting its Main or siblings', () => {
    seedOwner(mainAgentId, mainAgentId);
    seedOwner(mainAgentId, workerId);
    seedOwner(mainAgentId, 'worker-2');
    store.count(mainAgentId, workerId);

    store.deleteOwner(mainAgentId, workerId);

    expect(fs.existsSync(store.getOwnerDir(mainAgentId, workerId))).toBe(false);
    expect(fs.existsSync(store.getOwnerDir(mainAgentId, mainAgentId))).toBe(true);
    expect(fs.existsSync(store.getOwnerDir(mainAgentId, 'worker-2'))).toBe(true);
    const cachedPaths = [
      ...(store as unknown as { entryCounts: Map<string, unknown> }).entryCounts.keys(),
    ];
    expect(cachedPaths.some((filePath) => filePath.includes(workerId))).toBe(false);
  });

  it('deletes the Main and every nested Worker while preserving another AgentRun', () => {
    seedOwner(mainAgentId, mainAgentId);
    seedOwner(mainAgentId, workerId);
    seedOwner('main-2', 'main-2');
    store.count(mainAgentId, mainAgentId);
    store.count(mainAgentId, workerId);

    store.deleteAgentRun(mainAgentId);
    store.deleteAgentRun(mainAgentId);

    expect(fs.existsSync(path.join(root, 'agent-runs', mainAgentId))).toBe(false);
    expect(fs.existsSync(path.join(root, 'agent-runs', 'main-2'))).toBe(true);
    const cachedPaths = [
      ...(store as unknown as { entryCounts: Map<string, unknown> }).entryCounts.keys(),
    ];
    expect(cachedPaths.some((filePath) => filePath.includes(mainAgentId))).toBe(false);
  });
});
