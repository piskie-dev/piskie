import fs from 'node:fs/promises';
import { app } from 'electron';
import { RuntimeTraceWriter } from '../agent/tracing/runtime-trace-writer.js';
import type { AgentRuntimeObserver } from '../agent/observations.js';
import { AgentRunPaths } from './agent-run-paths.js';

export interface AgentRunTraceEntry {
  agentId: string;
  recentTail: string;
  tracePath: string;
}

const RECENT_TAIL_BYTES = 2 * 1024;
const RECENT_TAIL_LINES = 8;

interface ActiveTrace {
  recorder: RuntimeTraceWriter;
}

export class AgentRunTraceService {
  private readonly active = new Map<string, ActiveTrace>();
  private readonly paths: AgentRunPaths;

  constructor(userDataDirectory = app.getPath('userData')) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  tracePath(mainAgentId: string): string {
    return this.paths.tracePath({ agentId: mainAgentId });
  }

  async attach(mainAgentId: string): Promise<Pick<AgentRuntimeObserver, 'contentProduced'>> {
    await this.detach(mainAgentId);
    const recorder = new RuntimeTraceWriter(() => this.tracePath(mainAgentId));
    await recorder.initializeFile(mainAgentId);

    const observer: Pick<AgentRuntimeObserver, 'contentProduced'> = {
      contentProduced: (event) => {
        if (this.active.get(mainAgentId)?.recorder !== recorder) return;
        recorder.recordContentEvent(mainAgentId, event);
      },
    };
    this.active.set(mainAgentId, { recorder });
    return observer;
  }

  recordLifecycle(mainAgentId: string, type: string, message?: string): void {
    const trace = this.active.get(mainAgentId);
    trace?.recorder.recordLifecycle(mainAgentId, type, message);
  }

  async detach(mainAgentId: string): Promise<void> {
    const trace = this.active.get(mainAgentId);
    if (!trace) return;
    this.active.delete(mainAgentId);
    await trace.recorder.flush();
  }

  async list(): Promise<AgentRunTraceEntry[]> {
    const directories = await fs.readdir(this.paths.root, { withFileTypes: true }).catch(() => []);
    const entries = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const tracePath = this.tracePath(entry.name);
          try {
            const { recentTail, modifiedAtMs } = await this.readRecentTail(tracePath);
            return {
              entry: {
                agentId: entry.name,
                recentTail,
                tracePath,
              } satisfies AgentRunTraceEntry,
              modifiedAtMs,
            };
          } catch {
            return null;
          }
        })
    );

    return entries
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
      .map((item) => item.entry);
  }

  private async readRecentTail(
    tracePath: string
  ): Promise<{ recentTail: string; modifiedAtMs: number }> {
    const handle = await fs.open(tracePath, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(RECENT_TAIL_BYTES, stat.size);
      if (length === 0) return { recentTail: '', modifiedAtMs: stat.mtimeMs };

      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
      let content = buffer.subarray(0, bytesRead).toString('utf-8');
      if (stat.size > length) {
        const firstNewline = content.indexOf('\n');
        content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
      }
      const recentTail = content
        .split('\n')
        .filter((line) => line.length > 0)
        .slice(-RECENT_TAIL_LINES)
        .join('\n');
      return { recentTail, modifiedAtMs: stat.mtimeMs };
    } finally {
      await handle.close();
    }
  }
}

export const agentRunTraceService = new AgentRunTraceService();
