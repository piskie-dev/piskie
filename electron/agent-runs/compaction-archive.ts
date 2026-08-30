/**
 * CompactionArchive - 压缩原始消息归档与历史读取。
 *
 * 路径：agent-runs/{mainAgentId}/compaction/
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import type {
  CompactionHistoryView,
  CompactionMessagePage,
  ContextSummary,
  EnhancedMessage,
} from '../../shared/types/context.js';
import type {
  MessageSubtype,
} from '../../shared/types/index.js';
import { AgentRunPaths } from './agent-run-paths.js';

const MAX_MESSAGE_PAGE_SIZE = 100;

export class CompactionArchive {
  private readonly paths: AgentRunPaths;

  constructor(userDataDirectory = app.getPath('userData')) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  /**
   * 保存原始消息到临时文件
   * @returns 文件路径
   */
  async archiveOriginalMessages(
    mainAgentId: string,
    summaryId: string,
    messages: EnhancedMessage[]
  ): Promise<string> {
    const dir = this.paths.compactionDir(mainAgentId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${summaryId}.json`);

    await fs.writeFile(filePath, JSON.stringify(messages, null, 2), 'utf-8');
    return filePath;
  }

  async buildHistoryView(mainAgentId: string, summaries: ContextSummary[]): Promise<CompactionHistoryView> {
    const latestById = new Map<string, ContextSummary>();
    for (const summary of summaries) {
      if (summary?.id) latestById.set(summary.id, summary);
    }

    const ordered = [...latestById.values()].sort((a, b) => a.createdAt - b.createdAt);
    const views = await Promise.all(
      ordered.map(async (summary) => ({
        id: summary.id,
        markdown: summary.markdown,
        compressedCount: summary.compressedCount,
        originalTokens: summary.originalTokens,
        createdAt: summary.createdAt,
        hasOriginalMessages: await this.hasStoredFile(
          mainAgentId,
          summary.originalMessagesFile,
          `${summary.id}.json`
        ),
      }))
    );

    return {
      summaries: views,
      stats: {
        totalCompactions: views.length,
      },
    };
  }

  async readOriginalMessagePage(
    mainAgentId: string,
    summary: ContextSummary,
    offset = 0,
    limit = 50
  ): Promise<CompactionMessagePage> {
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimit = Number.isInteger(limit)
      ? Math.min(MAX_MESSAGE_PAGE_SIZE, Math.max(1, limit))
      : 50;
    const filePath = await this.resolveStoredFile(
      mainAgentId,
      summary.originalMessagesFile,
      `${summary.id}.json`
    );

    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Compaction message file is not an array');

    const messages = parsed.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const message = value as Partial<EnhancedMessage>;
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      if (typeof message.content !== 'string' && !Array.isArray(message.content)) return [];
      return [
        {
          role: message.role,
          content: message.content,
          timestamp: typeof message.timestamp === 'number' ? message.timestamp : 0,
          subtype: message.subtype as MessageSubtype | undefined,
        },
      ];
    });

    const end = Math.min(messages.length, safeOffset + safeLimit);
    return {
      items: messages.slice(safeOffset, end),
      total: messages.length,
      nextOffset: end < messages.length ? end : undefined,
    };
  }

  private async hasStoredFile(
    mainAgentId: string,
    storedPath: string | undefined,
    expectedFileName: string
  ): Promise<boolean> {
    try {
      await this.resolveStoredFile(mainAgentId, storedPath, expectedFileName);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveStoredFile(
    mainAgentId: string,
    storedPath: string | undefined,
    expectedFileName: string
  ): Promise<string> {
    if (!storedPath) throw new Error('Compaction source file is unavailable');
    if (path.basename(storedPath) !== expectedFileName) {
      throw new Error('Compaction source filename does not match its identifier');
    }

    const runsRoot = path.resolve(this.paths.root);
    const runRoot = path.resolve(this.paths.mainDir(mainAgentId));
    const candidate = path.resolve(storedPath);
    if (!this.isWithin(runsRoot, runRoot) || !this.isWithin(runRoot, candidate)) {
      throw new Error('Compaction source path is outside the owning AgentRun');
    }
    if (path.basename(path.dirname(candidate)) !== 'compaction') {
      throw new Error('Compaction source path is outside a compaction directory');
    }

    const [realRunsRoot, realRunRoot, realCandidate] = await Promise.all([
      fs.realpath(runsRoot),
      fs.realpath(runRoot),
      fs.realpath(candidate),
    ]);
    if (
      !this.isWithin(realRunsRoot, realRunRoot) ||
      !this.isWithin(realRunRoot, realCandidate) ||
      path.basename(realCandidate) !== expectedFileName ||
      path.basename(path.dirname(realCandidate)) !== 'compaction'
    ) {
      throw new Error('Compaction source resolves outside the owning AgentRun');
    }
    return realCandidate;
  }

  private isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}

export const compactionArchive = new CompactionArchive();
