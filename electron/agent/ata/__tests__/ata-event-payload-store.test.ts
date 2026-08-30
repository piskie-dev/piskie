import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'ata-event-payload-test-'));

vi.mock('electron', () => ({
  app: { getPath: () => TEST_ROOT },
}));

const { ATAEventPayloadStore } = await import('../ata-event-payload-store.js');

describe('ATAEventPayloadStore', () => {
  let store: InstanceType<typeof ATAEventPayloadStore>;

  beforeEach(async () => {
    await fs.rm(path.join(TEST_ROOT, 'agent-runs'), { recursive: true, force: true });
    store = new ATAEventPayloadStore(TEST_ROOT, () => 'Ab12Cd');
  });

  it('keeps a short current-version event inline without creating storage', async () => {
    const envelope = await store.prepareEnvelope(
      { agentId: 'main-1' },
      { type: 'message', message: 'hello' },
    );

    expect(envelope).toEqual({
      storage: 'inline',
      type: 'message',
      data: { type: 'message', message: 'hello' },
      originalSize: 5,
    });
    await expect(fs.access(path.join(TEST_ROOT, 'agent-runs'))).rejects.toThrow();
  });

  it('writes a long Main event to the Main owner ata-events directory', async () => {
    const message = 'm'.repeat(1001);
    const envelope = await store.prepareEnvelope(
      { agentId: 'main-1' },
      { type: 'completed', message, summary: 'main summary' },
    );

    expect(envelope.storage).toBe('file');
    if (envelope.storage !== 'file') throw new Error('expected file envelope');
    expect(envelope.filePath).toContain(path.join('agent-runs', 'main-1', 'ata-events'));
    expect(path.basename(envelope.filePath)).toBe('Ab12Cd.md');
    expect(envelope.summary).toBe('main summary');
    expect(await fs.readFile(envelope.filePath, 'utf-8')).toBe(message);
  });

  it('bounds the automatic preview while preserving the complete payload on disk', async () => {
    const message = 'm'.repeat(2_000);
    const envelope = await store.prepareEnvelope(
      { agentId: 'main-1' },
      { type: 'message', message },
    );

    expect(envelope.storage).toBe('file');
    if (envelope.storage !== 'file') throw new Error('expected file envelope');
    expect(envelope.summary).toBe(`${'m'.repeat(300)}…`);
    expect(await fs.readFile(envelope.filePath, 'utf-8')).toBe(message);
  });

  it('retries a compact id collision without overwriting the existing payload', async () => {
    const ids = ['Same01', 'Same01', 'Next02'];
    const collisionStore = new ATAEventPayloadStore(TEST_ROOT, () => ids.shift()!);
    const first = await collisionStore.prepareEnvelope(
      { agentId: 'main-1' },
      { type: 'message', message: 'a'.repeat(1001) },
    );
    const second = await collisionStore.prepareEnvelope(
      { agentId: 'main-1' },
      { type: 'message', message: 'b'.repeat(1001) },
    );

    expect(first.storage).toBe('file');
    expect(second.storage).toBe('file');
    if (first.storage !== 'file' || second.storage !== 'file') {
      throw new Error('expected file envelopes');
    }
    expect(path.basename(first.filePath)).toBe('Same01.md');
    expect(path.basename(second.filePath)).toBe('Next02.md');
    expect(await fs.readFile(first.filePath, 'utf-8')).toBe('a'.repeat(1001));
    expect(await fs.readFile(second.filePath, 'utf-8')).toBe('b'.repeat(1001));
  });

  it('writes a long Worker event to the Worker owner and never creates old ATA directories', async () => {
    const message = 'w'.repeat(1001);
    const envelope = await store.prepareEnvelope(
      { agentId: 'main-1', workerId: 'worker-1' },
      { type: 'failed', message, summary: 'worker summary' },
    );

    expect(envelope.storage).toBe('file');
    if (envelope.storage !== 'file') throw new Error('expected file envelope');
    expect(envelope.filePath).toContain(
      path.join('agent-runs', 'main-1', 'workers', 'worker-1', 'ata-events'),
    );
    await expect(
      fs.access(path.join(TEST_ROOT, 'agent-runs', 'main-1', 'ata')),
    ).rejects.toThrow();
  });

  it('degrades a long current-version event to inline when owner-local persistence fails', async () => {
    const blockedRoot = path.join(TEST_ROOT, 'blocked-root');
    await fs.writeFile(blockedRoot, 'not a directory', 'utf-8');
    const blockedStore = new ATAEventPayloadStore(blockedRoot);
    const eventData = {
      type: 'message',
      message: 'd'.repeat(1001),
      summary: 'degraded event',
    };

    const envelope = await blockedStore.prepareEnvelope({ agentId: 'main-degraded' }, eventData);

    expect(envelope).toEqual({
      storage: 'inline',
      type: 'message',
      data: eventData,
      originalSize: 1001,
    });
  });
});
