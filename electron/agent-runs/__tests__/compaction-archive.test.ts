import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-compaction-default' },
}));



import { CompactionArchive } from '../compaction-archive.js';
import type {
  ContextSummary,
  EnhancedMessage,
} from '../../../shared/types/context.js';

function message(index: number): EnhancedMessage {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: index,
  };
}

function summary(
  id: string,
  createdAt: number,
  originalMessagesFile?: string,
  overrides: Partial<ContextSummary> = {},
): ContextSummary {
  return {
    id,
    markdown: '# Compact summary\n\ntest task',
    compressedCount: 4,
    originalTokens: 100,
    createdAt,
    originalMessagesFile,
    ...overrides,
  };
}

describe('CompactionArchive', () => {
  let root: string;
  let service: CompactionArchive;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-compaction-'));
    service = new CompactionArchive(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds empty, sorted, deduplicated disk-backed history and totals', async () => {
    await expect(service.buildHistoryView('main-a', [])).resolves.toEqual({
      summaries: [],
      stats: { totalCompactions: 0 },
    });

    const oldFile = await service.archiveOriginalMessages('main-a', 'old', [message(0)]);
    const replacementFile = await service.archiveOriginalMessages(
      'main-a',
      'same',
      [message(1)],
    );
    const history = await service.buildHistoryView('main-a', [
      summary('same', 30, undefined),
      summary('old', 10, oldFile, { originalTokens: 10 }),
      summary('same', 20, replacementFile, { originalTokens: 90 }),
    ]);

    expect(history.summaries.map((item) => item.id)).toEqual(['old', 'same']);
    expect(history.summaries.map((item) => item.hasOriginalMessages)).toEqual([true, true]);
    expect(history.stats).toEqual({ totalCompactions: 2 });
    expect(history.summaries[1]).not.toHaveProperty('originalMessagesFile');
  });

  it('loads original messages in stable pages and caps the page size', async () => {
    const messages = Array.from({ length: 130 }, (_, index) => message(index));
    const file = await service.archiveOriginalMessages('main-a', 'page', messages);
    const storedSummary = summary('page', 1, file);

    const first = await service.readOriginalMessagePage('main-a', storedSummary, 0, 1_000);
    expect(first.items).toHaveLength(100);
    expect(first.items[0].content).toBe('message 0');
    expect(first.items[99].content).toBe('message 99');
    expect(first.total).toBe(130);
    expect(first.nextOffset).toBe(100);

    const second = await service.readOriginalMessagePage('main-a', storedSummary, 100, 50);
    expect(second.items).toHaveLength(30);
    expect(second.items[0].content).toBe('message 100');
    expect(second.nextOffset).toBeUndefined();
  });

  it('keeps history usable when a source file is missing or corrupt', async () => {
    const missing = summary(
      'missing',
      1,
      path.join(root, 'agent-runs', 'main-a', 'compaction', 'missing.json'),
    );
    const corruptPath = await service.archiveOriginalMessages('main-a', 'corrupt', [message(0)]);
    await fs.writeFile(corruptPath, '{not-json', 'utf8');
    const corrupt = summary('corrupt', 2, corruptPath);

    const history = await service.buildHistoryView('main-a', [missing, corrupt]);
    expect(history.summaries.map((item) => item.hasOriginalMessages)).toEqual([false, true]);
    await expect(service.readOriginalMessagePage('main-a', missing)).rejects.toThrow();
    await expect(service.readOriginalMessagePage('main-a', corrupt)).rejects.toThrow();
  });

  it('rejects filename changes, traversal, another flow, and absolute path tampering', async () => {
    const validPath = await service.archiveOriginalMessages('main-a', 'owned', [message(0)]);
    const otherRunPath = await service.archiveOriginalMessages(
      'main-b',
      'owned',
      [message(1)],
    );
    const outsideDir = path.join(root, 'outside', 'compaction');
    const outsidePath = path.join(outsideDir, 'owned.json');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(outsidePath, '[]', 'utf8');

    await expect(service.readOriginalMessagePage(
      'main-a',
      summary('renamed', 1, validPath),
    )).rejects.toThrow(/filename/);
    await expect(service.readOriginalMessagePage(
      '../outside',
      summary('owned', 1, outsidePath),
    )).rejects.toThrow(/outside/);
    await expect(service.readOriginalMessagePage(
      'main-a',
      summary('owned', 1, otherRunPath),
    )).rejects.toThrow(/outside/);
    await expect(service.readOriginalMessagePage(
      'main-a',
      summary('owned', 1, outsidePath),
    )).rejects.toThrow(/outside/);
  });

  it('rejects file and flow-directory symlink escapes', async () => {
    const outsideCompaction = path.join(root, 'outside', 'compaction');
    const outsideFile = path.join(outsideCompaction, 'linked.json');
    await fs.mkdir(outsideCompaction, { recursive: true });
    await fs.writeFile(outsideFile, '[]', 'utf8');

    const inRunCompaction = path.join(root, 'agent-runs', 'main-a', 'compaction');
    await fs.mkdir(inRunCompaction, { recursive: true });
    const linkedFile = path.join(inRunCompaction, 'linked.json');
    await fs.symlink(outsideFile, linkedFile);
    await expect(service.readOriginalMessagePage(
      'main-a',
      summary('linked', 1, linkedFile),
    )).rejects.toThrow(/outside/);

    const escapedRun = path.join(root, 'escaped-run');
    const escapedCompaction = path.join(escapedRun, 'compaction');
    await fs.mkdir(escapedCompaction, { recursive: true });
    const escapedFile = path.join(escapedCompaction, 'escaped.json');
    await fs.writeFile(escapedFile, '[]', 'utf8');
    await fs.symlink(escapedRun, path.join(root, 'agent-runs', 'main-link'));
    await expect(service.readOriginalMessagePage(
      'main-link',
      summary('escaped', 1, path.join(root, 'agent-runs', 'main-link', 'compaction', 'escaped.json')),
    )).rejects.toThrow(/outside/);
  });

  it('keeps main and worker artifacts in the main Agent compaction directory', async () => {
    const mainPath = await service.archiveOriginalMessages('main-a', 'main-summary', [message(0)]);
    const workerPath = await service.archiveOriginalMessages('main-a', 'worker-summary', [message(1)]);

    expect(path.dirname(mainPath)).toBe(path.join(root, 'agent-runs', 'main-a', 'compaction'));
    expect(path.dirname(workerPath)).toBe(path.dirname(mainPath));
    await expect(service.readOriginalMessagePage(
      'main-a',
      summary('worker-summary', 1, workerPath),
    )).resolves.toMatchObject({ total: 1 });
  });
});
