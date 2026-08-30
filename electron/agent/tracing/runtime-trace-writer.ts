import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentContentEvent } from '../../tools/types.js';

const MAX_TRACE_BYTES = 256 * 1024;
const SUMMARY_MAX_CHARS = 300;

export class RuntimeTraceWriter {
  private readonly sizes = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePathResolver: (runtimeId: string) => string) {}

  filePathFor(runtimeId: string): string {
    return this.filePathResolver(runtimeId);
  }

  initializeFile(runtimeId: string, headerLine?: string): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const filePath = this.filePathFor(runtimeId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const size = await fs.stat(filePath).then((stat) => stat.size).catch(() => 0);
      if (size === 0) {
        const content = headerLine ? `${headerLine.replace(/\s+/g, ' ').trim()}\n` : '';
        await fs.writeFile(filePath, content, 'utf-8');
        this.sizes.set(runtimeId, Buffer.byteLength(content, 'utf-8'));
      } else {
        this.sizes.set(runtimeId, size);
      }
    });
    return this.writeChain;
  }

  recordContentEvent(runtimeId: string, event: AgentContentEvent): void {
    let line: string | undefined;
    if (event.type === 'tool_start') {
      const args = event.params ? summarize(JSON.stringify(redactValue(event.params))) : '';
      line = `→ ${event.toolName ?? 'unknown'}(${args})`;
    } else if (event.type === 'tool_finish') {
      const marker = event.ok ? '✓' : '✗';
      line = `${marker} ${event.toolName ?? 'unknown'}${event.result ? `: ${summarize(event.result)}` : ''}`;
    } else if (event.type === 'assistant_text' && event.content) {
      line = `● ${summarize(event.content)}`;
    }
    if (line) this.append(runtimeId, line);
  }

  recordLifecycle(runtimeId: string, type: string, message?: string): void {
    this.append(runtimeId, `● 通知 ${type}${message ? `: ${summarize(message)}` : ''}`);
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private append(runtimeId: string, text: string): void {
    const line = `[${timestamp()}] ${text}\n`;
    this.writeChain = this.writeChain
      .then(() => this.write(runtimeId, line))
      .catch(() => {
        // Trace is diagnostic-only and must not fail the Agent runtime.
      });
  }

  private async write(runtimeId: string, line: string): Promise<void> {
    const filePath = this.filePathFor(runtimeId);
    let size = this.sizes.get(runtimeId);
    if (size === undefined) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      size = await fs.stat(filePath).then((stat) => stat.size).catch(() => 0);
    }

    const bytes = Buffer.byteLength(line, 'utf-8');
    if (size + bytes > MAX_TRACE_BYTES) {
      const content = await fs.readFile(filePath, 'utf-8').catch(() => '');
      let tail = content.slice(-Math.floor(MAX_TRACE_BYTES / 2));
      const newline = tail.indexOf('\n');
      if (newline >= 0) tail = tail.slice(newline + 1);
      const rebuilt = `（前文已滚动截断）\n${tail}${line}`;
      await fs.writeFile(filePath, rebuilt, 'utf-8');
      this.sizes.set(runtimeId, Buffer.byteLength(rebuilt, 'utf-8'));
      return;
    }

    await fs.appendFile(filePath, line, 'utf-8');
    this.sizes.set(runtimeId, size + bytes);
  }
}

function timestamp(): string {
  const date = new Date();
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function summarize(text: string): string {
  const oneLine = redactTraceText(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > SUMMARY_MAX_CHARS
    ? `${oneLine.slice(0, SUMMARY_MAX_CHARS)}…`
    : oneLine;
}

const SENSITIVE_KEY = /password|passwd|token|secret|api[_-]?key|authorization|cookie/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item),
    ]),
  );
}

function redactTraceText(text: string): string {
  return text
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)["']?\s*[=:]\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)["']?\s*[=:]\s*)'(?:\\.|[^'\\])*'/gi, "$1'[REDACTED]'")
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)["']?\s*[=:]\s*)(?!["'])[^,\n\r}]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]');
}
