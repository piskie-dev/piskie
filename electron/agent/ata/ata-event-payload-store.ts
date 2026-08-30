import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCompactId } from '@shared/utils/identifiers.js';
import { appLog } from '../../observability/logging/app-log.js';
import { AgentRunPaths } from '../../agent-runs/agent-run-paths.js';
import type { AgentTarget } from '@shared/types/agent-control.js';
import type {
  ATAEventEnvelope,
  ATAEventPayload,
} from './ata-event-envelope.js';

const ATA_EVENT_INLINE_MESSAGE_THRESHOLD_CHARS = 1000;
const ATA_EVENT_SUMMARY_MAX_CHARS = 300;
const ATA_EVENT_FILE_ID_ATTEMPTS = 100;

export class ATAEventPayloadStore {
  private readonly paths: AgentRunPaths;

  constructor(
    userDataDirectory = app.getPath('userData'),
    private readonly createPayloadId: () => string = createCompactId,
  ) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  async prepareEnvelope(
    source: AgentTarget,
    eventData: ATAEventPayload,
  ): Promise<ATAEventEnvelope> {
    const { type, message } = eventData;
    if (message.length <= ATA_EVENT_INLINE_MESSAGE_THRESHOLD_CHARS) {
      return { storage: 'inline', type, data: eventData, originalSize: message.length };
    }

    const summary = eventSummary(eventData);
    try {
      const filePath = await this.persistPayload(source, message);
      return { storage: 'file', type, summary, filePath, originalSize: message.length };
    } catch (error) {
      appLog.warn({
        event: 'agent.ata.payload.persist.degraded',
        message: 'ATA event payload persistence degraded to inline content',
        context: {
          scope: 'agent.ata',
          agentId: source.agentId,
          ...(source.workerId && { workerId: source.workerId }),
        },
        error,
      });
      return { storage: 'inline', type, data: eventData, originalSize: message.length };
    }
  }

  private async persistPayload(
    source: AgentTarget,
    content: string,
  ): Promise<string> {
    const targetDirectory = this.paths.ataEventPayloadDir(source);
    await fs.mkdir(targetDirectory, { recursive: true });
    for (let attempt = 0; attempt < ATA_EVENT_FILE_ID_ATTEMPTS; attempt += 1) {
      const filePath = path.join(targetDirectory, `${this.createPayloadId()}.md`);
      try {
        await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
        return filePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Unable to allocate a unique ATA event payload file');
  }
}

function eventSummary(eventData: ATAEventPayload): string {
  const explicit = eventData.summary?.trim();
  if (explicit) return explicit;
  const preview = (eventData.message.trim() || `${eventData.type} event`).replace(/\s+/g, ' ');
  return preview.length > ATA_EVENT_SUMMARY_MAX_CHARS
    ? `${preview.slice(0, ATA_EVENT_SUMMARY_MAX_CHARS)}…`
    : preview;
}

export const ataEventPayloadStore = new ATAEventPayloadStore();
