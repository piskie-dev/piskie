import path from 'node:path';
import type { AgentTarget } from '@shared/types/agent-control.js';

/** Resolves every persistent path owned by one top-level AgentRun. */
export class AgentRunPaths {
  readonly root: string;

  constructor(userDataDirectory: string) {
    this.root = path.join(userDataDirectory, 'agent-runs');
  }

  mainDir(mainAgentId: string): string {
    return path.join(this.root, mainAgentId);
  }

  ownerDir(mainAgentId: string, agentId: string): string {
    return agentId === mainAgentId
      ? this.mainDir(mainAgentId)
      : path.join(this.mainDir(mainAgentId), 'workers', agentId);
  }

  headerPath(mainAgentId: string): string {
    return path.join(this.mainDir(mainAgentId), 'header.json');
  }

  conversationPath(mainAgentId: string, agentId: string): string {
    return path.join(this.ownerDir(mainAgentId, agentId), 'conversation.jsonl');
  }

  blobsDir(mainAgentId: string, agentId: string): string {
    return path.join(this.ownerDir(mainAgentId, agentId), 'blobs');
  }

  screenshotsDir(mainAgentId: string, agentId: string): string {
    return path.join(this.ownerDir(mainAgentId, agentId), 'screenshots');
  }

  tasksPath(mainAgentId: string): string {
    return path.join(this.mainDir(mainAgentId), 'tasks.json');
  }

  ataEventPayloadDir(target: AgentTarget): string {
    return path.join(this.targetOwnerDir(target), 'ata-events');
  }

  plansDir(mainAgentId: string): string {
    return path.join(this.mainDir(mainAgentId), 'plans');
  }

  compactionDir(mainAgentId: string): string {
    return path.join(this.mainDir(mainAgentId), 'compaction');
  }

  tracePath(target: AgentTarget): string {
    return path.join(this.targetOwnerDir(target), 'trace.md');
  }

  private targetOwnerDir(target: AgentTarget): string {
    return target.workerId
      ? path.join(this.mainDir(target.agentId), 'workers', target.workerId)
      : this.mainDir(target.agentId);
  }
}
