import { appLog } from '@electron/observability/logging/app-log.js';
/**
 * ConversationStore — JSONL 对话存储
 * AgentRun Conversation 与 Header 的唯一磁盘 owner。
 *
 * 核心不变量：Write-Before-Emit
 * - append() 是同步的（fs.appendFileSync），写完磁盘才返回
 * - 落盘成功后才向只读 append source 发布事实
 * - 前端展示的 = 磁盘上持久化的 = resume 恢复的
 *
 * 存储布局：Main 位于 agent-runs/{mainAgentId}，Worker 位于同一根目录的
 * workers/{agentId}。Header 只属于顶层 AgentRun。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';
import type {
  ConversationEntry,
  ConversationWriteEntry,
  ConversationAppendMetadata,
  AgentRunHeader,
  ImageRefBlock,
  PersistedMessageBlock,
  PersistedToolResultBlock,
} from '../../shared/types/agent-control.js';
import type { ContentBlock, ToolResultContentBlock } from '../../shared/types/index.js';
import type {
  ConversationPage,
  ConversationPageRequest,
} from '../../shared/electron-contracts/agents.js';
import { createChangeChannel, type ChangeSource, type Unsubscribe } from '../core/change-channel.js';
import { AgentRunPaths } from './agent-run-paths.js';

const PERSISTED_PLAIN_MESSAGE_TYPES = new Set([
  'text',
  'tool_use',
  'thinking',
  'redacted_thinking',
  'openai_reasoning',
]);

const PERSISTED_MESSAGE_FIELDS = [
  'text',
  'thinking',
  'signature',
  'data',
  'protocol',
  'summary',
  'reasoning_content',
  'encrypted_content',
  'status',
  'id',
  'name',
  'input',
  'provider_item_id',
  'tool_use_id',
  'is_error',
] as const;

const IMAGE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

export interface ConversationAppendRecord extends ConversationAppendMetadata {
  mainAgentId: string;
  agentId: string;
  index: number;
  entry: ConversationEntry;
}

export class ConversationStore {
  readonly paths: AgentRunPaths;
  /**
   * 每文件条目计数缓存（count = 可解析条目数，size = 缓存时文件字节数）。
   * size 用于失效检测：文件被本实例之外修改时自动重新解析。
   * 行号可信的前提：同一 conversation 文件只有属主 runtime 单线程追加。
   */
  private entryCounts: Map<string, { count: number; size: number }> = new Map();
  private lineIndexes: Map<string, {
    size: number;
    lines: Array<{ start: number; end: number }>;
  }> = new Map();
  private readIssueCount = 0;
  private readonly appendChannel = createChangeChannel<ConversationAppendRecord>({
    onSubscriberError: (error, change) =>
      appLog.error({
        event: 'storage.conversation_event.publish.failed',
        message: 'Conversation append publication failed',
        context: {
          scope: 'storage.conversation_event',
          mainAgentId: change.mainAgentId,
          agentId: change.agentId,
          index: change.index,
        },
        error,
      }),
  });

  readonly appends: ChangeSource<ConversationAppendRecord> = this.appendChannel.source;

  constructor(userDataDirectory: string) {
    this.paths = new AgentRunPaths(userDataDirectory);
  }

  subscribeAppends(
    listener: (change: ConversationAppendRecord) => void,
    options?: { signal?: AbortSignal }
  ): Unsubscribe {
    return this.appends.subscribe(listener, options);
  }

  // ============================================================
  // JSONL 操作
  // ============================================================

  /**
   * 追加一条对话条目（同步写入），返回该条目的行号（可解析条目序号，从 0 开始）。
   * 落盘成功后才发布 append observation（Write-Before-Publish）。
   */
  append(
    mainAgentId: string,
    agentId: string,
    entry: ConversationWriteEntry,
    metadata: ConversationAppendMetadata = {}
  ): number {
    const filePath = this.getConversationPath(mainAgentId, agentId);
    this.ensureDirSync(path.dirname(filePath));
    this.ensureTrailingNewline(filePath);

    const processed = this.toCanonicalEntry(mainAgentId, agentId, entry);
    const line = JSON.stringify(processed) + '\n';
    const lineIndex = this.getLineIndex(filePath);
    const index = lineIndex.lines.length;
    const start = lineIndex.size;
    fs.appendFileSync(filePath, line, 'utf-8');
    const size = this.statSizeSync(filePath);
    const end = start + Buffer.byteLength(line, 'utf8') - 1;
    this.lineIndexes.set(filePath, {
      size,
      lines: [...lineIndex.lines, { start, end }],
    });
    this.entryCounts.set(filePath, { count: index + 1, size });
    this.appendChannel.sink.publish({ mainAgentId, agentId, index, entry: processed, ...metadata });
    return index;
  }

  /**
   * 读取全部对话条目
   * 损坏的末行（崩溃导致）自动丢弃
   */
  read(mainAgentId: string, agentId: string): ConversationEntry[] {
    const filePath = this.getConversationPath(mainAgentId, agentId);
    const index = this.getLineIndex(filePath);
    return this.readIndexedRange(filePath, index.lines, 0, index.lines.length);
  }

  /**
   * 从指定偏移量开始读取（前端增量拉取）
   * offset 是行号（从 0 开始）
   */
  readFrom(mainAgentId: string, agentId: string, fromOffset: number): ConversationEntry[] {
    const filePath = this.getConversationPath(mainAgentId, agentId);
    const index = this.getLineIndex(filePath);
    return this.readIndexedRange(filePath, index.lines, fromOffset, index.lines.length);
  }

  readPage(
    mainAgentId: string,
    agentId: string,
    page: ConversationPageRequest,
  ): ConversationPage {
    const filePath = this.getConversationPath(mainAgentId, agentId);
    const index = this.getLineIndex(filePath);
    const total = index.lines.length;
    let from: number;
    let to: number;
    switch (page.direction) {
      case 'tail':
        from = Math.max(0, total - page.limit);
        to = total;
        break;
      case 'forward':
        from = Math.min(page.from, total);
        to = Math.min(total, from + page.limit);
        break;
      case 'backward':
        to = Math.min(page.before, total);
        from = Math.max(0, to - page.limit);
        break;
    }
    return {
      from,
      entries: this.readIndexedRange(filePath, index.lines, from, to),
      total,
    };
  }

  /**
   * 返回对话条目总数（用于 AgentControlState.conversationLength）。
   * 与 read() 同一定义：可解析条目数（损坏行不计入），带 size 校验的缓存。
   */
  count(mainAgentId: string, agentId: string): number {
    return this.getEntryCount(this.getConversationPath(mainAgentId, agentId));
  }

  // ============================================================
  // Header 操作
  // ============================================================

  /**
   * 写入 header.json（原子写：.tmp + rename）
   */
  writeHeader(mainAgentId: string, header: AgentRunHeader): void {
    const filePath = this.paths.headerPath(mainAgentId);
    this.ensureDirSync(path.dirname(filePath));

    const tmpPath = `${filePath}.tmp`;
    const json = JSON.stringify(header, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * 读取 header.json
   */
  readHeader(mainAgentId: string): AgentRunHeader | null {
    const filePath = this.paths.headerPath(mainAgentId);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const value: unknown = JSON.parse(content);
      const parsed = agentRunHeaderSchema.safeParse(value);
      return parsed.success && parsed.data.agentId === mainAgentId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * 只扫描 agent-runs 的直接子目录；Worker 不形成独立 AgentRun。
   */
  scanHeaders(): AgentRunHeader[] {
    if (!fs.existsSync(this.paths.root)) return [];

    const headers: AgentRunHeader[] = [];
    for (const mainAgentId of this.readdirSafeSync(this.paths.root)) {
      if (!this.isDirectorySync(this.paths.mainDir(mainAgentId))) continue;
      const header = this.readHeader(mainAgentId);
      if (header) headers.push(header);
    }

    return headers;
  }

  findMainAgentId(agentId: string): string | null {
    if (this.readHeader(agentId)) return agentId;
    for (const mainAgentId of this.readdirSafeSync(this.paths.root)) {
      const workerDir = this.paths.ownerDir(mainAgentId, agentId);
      if (this.isDirectorySync(workerDir)) return mainAgentId;
    }
    return null;
  }

  hasAgentId(agentId: string): boolean {
    return this.findMainAgentId(agentId) !== null;
  }

  listWorkerIds(mainAgentId: string): string[] {
    const workersDir = path.join(this.paths.mainDir(mainAgentId), 'workers');
    return this.readdirSafeSync(workersDir)
      .filter((workerId) => this.isDirectorySync(this.paths.ownerDir(mainAgentId, workerId)));
  }

  /**
   * 删除一个 agent 的全部存储（header + conversation + blobs）
   */
  deleteOwner(mainAgentId: string, agentId: string): void {
    const ownerDir = this.paths.ownerDir(mainAgentId, agentId);
    this.clearEntryCountsUnder(ownerDir);
    try {
      fs.rmSync(ownerDir, { recursive: true, force: true });
    } catch (error) {
      appLog.error({
        event: 'storage.conversation.cleanup.failed',
        message: 'Conversation cleanup failed',
        context: { scope: 'storage.conversation', mainAgentId, agentId },
        error,
      });
    }
  }

  deleteAgentRun(mainAgentId: string): void {
    const mainDir = this.paths.mainDir(mainAgentId);
    this.clearEntryCountsUnder(mainDir);
    fs.rmSync(mainDir, { recursive: true, force: true });
  }

  // ============================================================
  // 路径工具
  // ============================================================

  getOwnerDir(mainAgentId: string, agentId: string): string {
    return this.paths.ownerDir(mainAgentId, agentId);
  }

  getConversationPath(mainAgentId: string, agentId: string): string {
    return this.paths.conversationPath(mainAgentId, agentId);
  }

  getBlobsDir(mainAgentId: string, agentId: string): string {
    return this.paths.blobsDir(mainAgentId, agentId);
  }

  // ============================================================
  // 图片持久化与恢复
  // ============================================================

  /** Blob files are committed before their canonical JSONL references are returned. */
  private toCanonicalEntry(
    mainAgentId: string,
    agentId: string,
    entry: ConversationWriteEntry
  ): ConversationEntry {
    if (entry.t === 'msg') {
      const content =
        typeof entry.content === 'string'
          ? entry.content
          : this.externalizeMessageBlocks(mainAgentId, agentId, entry.content);
      if (entry.role === 'user') {
        return {
          t: 'msg',
          ts: entry.ts,
          id: entry.id,
          role: 'user',
          content,
          subtype: entry.subtype,
        };
      }
      return {
        t: 'msg',
        ts: entry.ts,
        id: entry.id,
        role: 'assistant',
        content,
      };
    }

    if (entry.t === 'tool') {
      return {
        t: 'tool',
        ts: entry.ts,
        toolUseId: entry.toolUseId,
        result: this.externalizeToolResultBlocks(mainAgentId, agentId, entry.result),
        ok: entry.ok,
        ...(entry.artifacts?.length ? { artifacts: entry.artifacts } : {}),
      };
    }

    if (entry.t === 'summary') return { t: 'summary', ts: entry.ts, summary: entry.summary };
    return { t: 'marker', ts: entry.ts, key: entry.key, value: entry.value };
  }

  private externalizeMessageBlocks(
    mainAgentId: string,
    agentId: string,
    blocks: ContentBlock[]
  ): PersistedMessageBlock[] {
    return blocks.map((block): PersistedMessageBlock => {
      if (block.type === 'image') {
        return this.externalizeRuntimeImage(mainAgentId, agentId, block.source);
      }
      if (block.type === 'tool_result') {
        return {
          ...this.pickKnownMessageFields({ ...block }),
          type: 'tool_result',
          content: Array.isArray(block.content)
            ? this.externalizeToolResultBlocks(mainAgentId, agentId, block.content)
            : block.content,
        } as PersistedMessageBlock;
      }
      if (!PERSISTED_PLAIN_MESSAGE_TYPES.has(block.type)) {
        throw new Error(`Unsupported conversation block type: ${block.type}`);
      }
      return this.pickKnownMessageFields({ ...block }) as PersistedMessageBlock;
    });
  }

  private externalizeToolResultBlocks(
    mainAgentId: string,
    agentId: string,
    result: ToolResultContentBlock[]
  ): PersistedToolResultBlock[] {
    return result.map((block): PersistedToolResultBlock => {
      if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
      return this.externalizeRuntimeImage(mainAgentId, agentId, block.source);
    });
  }

  private externalizeRuntimeImage(
    mainAgentId: string,
    agentId: string,
    source: ContentBlock['source'] | ToolResultContentBlock['source']
  ): ImageRefBlock {
    if (
      source?.type !== 'base64' ||
      typeof source.media_type !== 'string' ||
      source.media_type.length === 0 ||
      typeof source.data !== 'string' ||
      source.data.length === 0
    ) {
      throw new Error('Conversation image must contain non-empty Base64 data and media type');
    }
    return this.writeBlobFromBase64(mainAgentId, agentId, source.data, source.media_type);
  }

  /**
   * Restore canonical references for the model without blocking Electron's event loop.
   * A broken image becomes one text block and never aborts the rest of replay.
   */
  async materializeToolResultBlocks(
    mainAgentId: string,
    agentId: string,
    blocks: readonly PersistedToolResultBlock[]
  ): Promise<ToolResultContentBlock[]> {
    return Promise.all(
      blocks.map(async (block): Promise<ToolResultContentBlock> => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        return this.materializeImageRef(mainAgentId, agentId, block);
      })
    );
  }

  async materializeMessageContent(
    mainAgentId: string,
    agentId: string,
    content: string | readonly PersistedMessageBlock[]
  ): Promise<string | ContentBlock[]> {
    if (typeof content === 'string') return content;
    return Promise.all(
      content.map(async (block): Promise<ContentBlock> => {
        if (block.type === 'image_ref') {
          return this.materializeImageRef(mainAgentId, agentId, block) as Promise<ContentBlock>;
        }
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          return {
            ...block,
            content: await this.materializeToolResultBlocks(mainAgentId, agentId, block.content),
          } as ContentBlock;
        }
        return block as ContentBlock;
      })
    );
  }

  private async materializeImageRef(
    mainAgentId: string,
    agentId: string,
    block: ImageRefBlock
  ): Promise<ToolResultContentBlock> {
    const blobsDir = path.resolve(this.getBlobsDir(mainAgentId, agentId));
    const resolved = path.resolve(this.getOwnerDir(mainAgentId, agentId), block.path);
    if (!resolved.startsWith(`${blobsDir}${path.sep}`)) {
      appLog.error({
        event: 'storage.image_ref.read.rejected',
        message: 'Conversation image reference was rejected',
        context: {
          scope: 'storage.image_ref',
          mainAgentId,
          agentId,
          reason: 'path_outside_blob_directory',
        },
      });
      return { type: 'text', text: `[图片不可用：引用路径越界 ${block.path}]` };
    }

    try {
      const data = (await fs.promises.readFile(resolved)).toString('base64');
      return { type: 'image', source: { type: 'base64', media_type: block.mediaType, data } };
    } catch (error) {
      appLog.error({
        event: 'storage.image_ref.read.failed',
        message: 'Conversation image reference read failed',
        context: {
          scope: 'storage.image_ref',
          mainAgentId,
          agentId,
          referencePath: block.path,
        },
        error,
      });
      return { type: 'text', text: `[图片不可用：blob 缺失或读取失败 ${block.path}]` };
    }
  }

  /**
   * 渲染进程投影：image_ref 相对路径 → 绝对路径（纯投影，盘上持久格式保持相对、可随 userData 迁移）。
   * Covers messages, nested tool results and top-level tool results.
   */
  absolutizeImageRefs(
    mainAgentId: string,
    agentId: string,
    entry: ConversationEntry
  ): ConversationEntry {
    const agentDir = this.getOwnerDir(mainAgentId, agentId);
    const mapRef = (block: ImageRefBlock): ImageRefBlock => ({
      ...block,
      path: path.isAbsolute(block.path) ? block.path : path.join(agentDir, block.path),
    });
    const mapResult = (block: PersistedToolResultBlock): PersistedToolResultBlock =>
      block.type === 'image_ref' ? mapRef(block) : block;
    const mapMessage = (block: PersistedMessageBlock): PersistedMessageBlock => {
      if (block.type === 'image_ref') return mapRef(block);
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return { ...block, content: block.content.map(mapResult) };
      }
      return block;
    };

    if (entry.t === 'msg' && Array.isArray(entry.content)) {
      return { ...entry, content: entry.content.map(mapMessage) };
    }
    if (entry.t === 'tool') {
      return {
        ...entry,
        result: entry.result.map(mapResult),
      };
    }
    return entry;
  }

  /**
   * 写入 blob 文件（原子写：tmp + rename）
   * 返回 ImageRefBlock 引用
   */
  private writeBlobFromBase64(
    mainAgentId: string,
    agentId: string,
    base64Data: string,
    mediaType: string
  ): ImageRefBlock {
    const buffer = this.decodeBase64(base64Data);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const ext = this.mediaTypeToExt(mediaType);
    const fileName = `${hash}.${ext}`;

    const blobsDir = this.getBlobsDir(mainAgentId, agentId);
    this.ensureDirSync(blobsDir);

    const blobPath = path.join(blobsDir, fileName);

    if (!fs.existsSync(blobPath)) {
      const tmpPath = `${blobPath}.tmp`;
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, blobPath);
    }

    return {
      type: 'image_ref',
      path: `blobs/${fileName}`,
      size: buffer.length,
      mediaType,
    };
  }

  private decodeBase64(data: string): Buffer {
    const normalized = data.replace(/\s/g, '');
    if (
      normalized.length === 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
      normalized.replace(/=+$/, '').length % 4 === 1
    ) {
      throw new Error('Conversation image contains invalid Base64 data');
    }
    const buffer = Buffer.from(normalized, 'base64');
    const padded = buffer.toString('base64');
    const unpadded = padded.replace(/=+$/, '');
    if (buffer.length === 0 || (normalized !== padded && normalized !== unpadded)) {
      throw new Error('Conversation image contains invalid Base64 data');
    }
    return buffer;
  }

  // ============================================================
  // 内部工具方法
  // ============================================================

  /** 带 size 失效校验的条目计数（与 read() 同一解析逻辑） */
  private getEntryCount(filePath: string): number {
    const size = this.statSizeSync(filePath);
    if (size < 0) return 0;
    const cached = this.entryCounts.get(filePath);
    if (cached && cached.size === size) return cached.count;
    const count = this.getLineIndex(filePath).lines.length;
    this.entryCounts.set(filePath, { count, size });
    return count;
  }

  private clearEntryCountsUnder(directory: string): void {
    const prefix = `${directory}${path.sep}`;
    for (const filePath of this.entryCounts.keys()) {
      if (filePath.startsWith(prefix)) this.entryCounts.delete(filePath);
    }
    for (const filePath of this.lineIndexes.keys()) {
      if (filePath.startsWith(prefix)) this.lineIndexes.delete(filePath);
    }
  }

  /**
   * 崩溃/磁盘写满可能留下无换行符的截断末行；直接追加会把新条目粘进残行导致两条全坏。
   * 每次 append 前检查末字节，补 '\n' 把残行隔离成独立坏行（读取时跳过）。
   */
  private ensureTrailingNewline(filePath: string): void {
    let fd: number | null = null;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) return;
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, stat.size - 1);
      if (buf[0] !== 0x0a) {
        fs.appendFileSync(filePath, '\n', 'utf-8');
        appLog.warn({
          event: 'storage.conversation.repair.completed',
          message: 'Truncated conversation line was isolated',
          context: { scope: 'storage.conversation', filePath },
        });
      }
    } catch {
      // 文件不存在 — 无需处理
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private statSizeSync(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return -1;
    }
  }

  private getLineIndex(filePath: string): {
    size: number;
    lines: Array<{ start: number; end: number }>;
  } {
    const size = this.statSizeSync(filePath);
    if (size < 0) return { size: 0, lines: [] };
    const cached = this.lineIndexes.get(filePath);
    if (cached?.size === size) return cached;

    const bytes = fs.readFileSync(filePath);
    const lines: Array<{ start: number; end: number }> = [];
    let start = 0;
    let physicalLine = 0;
    for (let cursor = 0; cursor <= bytes.length; cursor += 1) {
      if (cursor < bytes.length && bytes[cursor] !== 0x0a) continue;
      const end = cursor;
      const text = bytes.subarray(start, end).toString('utf8').trim();
      if (text) {
        try {
          JSON.parse(text);
          lines.push({ start, end });
        } catch {
          this.reportReadIssue(
            filePath,
            physicalLine,
            cursor === bytes.length ? 'truncated_tail' : 'invalid_json',
          );
        }
      }
      start = cursor + 1;
      physicalLine += 1;
    }
    const built = { size, lines };
    this.lineIndexes.set(filePath, built);
    this.entryCounts.set(filePath, { count: lines.length, size });
    return built;
  }

  private readIndexedRange(
    filePath: string,
    lines: readonly { start: number; end: number }[],
    requestedFrom: number,
    requestedTo: number,
  ): ConversationEntry[] {
    const from = Math.max(0, Math.min(requestedFrom, lines.length));
    const to = Math.max(from, Math.min(requestedTo, lines.length));
    if (from === to) return [];
    const first = lines[from]!;
    const last = lines[to - 1]!;
    const length = last.end - first.start;
    const bytes = Buffer.allocUnsafe(length);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, bytes, 0, length, first.start);
    } finally {
      fs.closeSync(fd);
    }
    return lines.slice(from, to).map((line) => {
      const relativeStart = line.start - first.start;
      const relativeEnd = line.end - first.start;
      return JSON.parse(bytes.subarray(relativeStart, relativeEnd).toString('utf8')) as ConversationEntry;
    });
  }

  private reportReadIssue(filePath: string, lineIndex: number, reason: string): void {
    if (this.readIssueCount >= 3) return;
    this.readIssueCount += 1;
    appLog.warn({
      event: 'storage.conversation.read.degraded',
      message: 'Invalid conversation data was skipped',
      context: { scope: 'storage.conversation', filePath, lineIndex, reason },
    });
  }

  private pickKnownMessageFields(value: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { type: value.type };
    for (const key of PERSISTED_MESSAGE_FIELDS) {
      if (value[key] !== undefined) result[key] = value[key];
    }
    return result;
  }

  private mediaTypeToExt(mediaType: string): string {
    return IMAGE_FILE_EXTENSIONS[mediaType] ?? 'bin';
  }

  private ensureDirSync(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private readdirSafeSync(dirPath: string): string[] {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  }

  private isDirectorySync(dirPath: string): boolean {
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }
}

const fingerprintSchema = z.object({
  platform: z.enum(['macos', 'windows', 'linux']).optional(),
  clientHintsFromUA: z.boolean().optional(),
  webrtc: z.enum(['proxy', 'real']).optional(),
  hardwareConcurrency: z.number().optional(),
  geoMode: z.enum(['block', 'real']).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const advancedSettingsSchema = z.object({
  language: z.string().optional(),
  userAgent: z.string().optional(),
  backgroundMode: z.boolean().optional(),
  fingerprint: fingerprintSchema.optional(),
});

const runConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.string().optional(),
  promptTemplate: z.string(),
  systemPrompt: z.string().optional(),
  workspace: z.string().optional(),
  bindings: z.object({
    type: z.literal('standard'),
    boundEnvironmentIds: z.array(z.string()).optional(),
  }).optional(),
  advancedSettings: advancedSettingsSchema.optional(),
  mcpServers: z.array(z.string()).optional(),
});

const childSnapshotSchema = z.object({
  id: z.string(),
  config: z.object({
    mode: z.enum(['browser', 'local']),
    subject: z.string(),
    taskIds: z.array(z.string()),
    prompt: z.string(),
    skills: z.array(z.string()).optional(),
    agentSpec: z.string().optional(),
    browserEnvironmentId: z.string().optional(),
    advancedSettings: advancedSettingsSchema.optional(),
  }),
  createdAt: z.number(),
});

const agentRunHeaderSchema: z.ZodType<AgentRunHeader> = z.object({
  agentId: z.string(),
  agentSpec: z.string(),
  modeId: z.string(),
  runConfig: runConfigSchema,
  createdAt: z.string(),
  lastActiveAt: z.string(),
  currentModel: z.string(),
  approvalMode: z.enum(['auto', 'confirm']),
  childAgents: z.array(childSnapshotSchema),
});
