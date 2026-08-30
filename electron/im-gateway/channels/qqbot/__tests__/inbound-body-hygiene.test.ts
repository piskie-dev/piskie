import { createUuid } from '@shared/utils/identifiers.js';
/**
 * QQ vendor 入站附件真实链路正文卫生
 *
 * 走真实 processAttachments / formatAttachmentTags / formatMessageReferenceForAgent
 * （仅 stub 网络 fetch 与 ConnectorContext.media.saveBuffer 缝），覆盖：
 * - 非语音附件经 ctx.saveMedia 直接落受管目录，vendor 状态根零落盘
 * - 图片下载失败保留远程 URL 交核心层受管下载；其他附件失败 → download-failed:// 哨兵
 * - 正文/引用文本不含本地路径、远程 URL、MEDIA: 占位符
 * - 引用消息附件格式化后立即清理（无 ownership handoff 不泄漏）
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 直接公网 IP（TEST-NET-2 文档保留段）：SSRF 守卫即时判定，测试不做 DNS 解析
const IMG_URL = 'http://198.51.100.7/photo.png';
const FILE_URL = 'http://198.51.100.7/report.pdf';

let vendorHome: string;
let savedHome: string | undefined;
/* eslint-disable @typescript-eslint/no-explicit-any -- vendor JS 无类型声明 */
let processAttachments: any;
let formatAttachmentTags: any;
let formatMessageReferenceForAgent: any;
let buildInboundDynamicContext: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeAll(async () => {
  // vendor 状态根（~/.openclaw/…）沙箱化：HOME 指向 tmpdir 后再动态 import
  // （ref-index-store 模块顶层即 mkdir 数据目录；getQQBotMediaDir 调用期取 HOME）
  vendorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-vendor-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = vendorHome;
  ({ processAttachments, buildInboundDynamicContext } = await import('../vendor/src/inbound-attachments.js'));
  ({ formatAttachmentTags } = await import('../vendor/src/group-history.js'));
  ({ formatMessageReferenceForAgent } = await import('../vendor/src/ref-index-store.js'));
});

afterAll(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  vi.unstubAllGlobals();
  fs.rmSync(vendorHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

/** 模拟 ConnectorContext.media.saveBuffer 落"受管目录"的 saveMedia 缝 */
function makeCtx() {
  const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-media-fake-'));
  const saveMedia = vi.fn(async (buffer: Buffer) => {
    const p = path.join(managedDir, `m-${createUuid()}`);
    fs.writeFileSync(p, buffer);
    return p;
  });
  return {
    ctx: { appId: 'app1', peerId: 'peer1', cfg: {}, log: undefined, saveMedia },
    managedDir,
    saveMedia,
  };
}

function stubFetchOk(body: Buffer, contentType: string): void {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentType } })));
}

/** 404 → 不可重试（status < 500），单次尝试即失败，测试无退避等待 */
function stubFetch404(): void {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response('nope', { status: 404, statusText: 'Not Found' })));
}

/** 递归列出目录下全部普通文件 */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

describe('processAttachments 真实链路', () => {
  it('图片下载成功 → 经 ctx.saveMedia 直接落受管目录，vendor 状态根零落盘', async () => {
    stubFetchOk(PNG_MAGIC, 'image/png');
    const { ctx, managedDir, saveMedia } = makeCtx();

    const result = await processAttachments(
      [{ url: IMG_URL, filename: 'photo.png', content_type: 'image/png' }], ctx);

    expect(saveMedia).toHaveBeenCalledTimes(1);
    expect(result.imageUrls).toHaveLength(1);
    const saved = result.imageUrls[0];
    expect(path.dirname(saved)).toBe(managedDir);
    expect(fs.readFileSync(saved).equals(PNG_MAGIC)).toBe(true);
    expect(result.attachmentLocalPaths).toEqual([saved]);
    // 原始下载文件不在 vendor 目录保留，只保留移交到受管目录的副本。
    expect(listFiles(vendorHome)).toEqual([]);
  });

  it('图片下载失败（HTTP 404 不可重试）→ 保留远程 URL 交核心层受管下载，不落任何盘', async () => {
    stubFetch404();
    const { ctx, saveMedia } = makeCtx();

    const result = await processAttachments(
      [{ url: IMG_URL, filename: 'photo.png', content_type: 'image/png' }], ctx);

    expect(saveMedia).not.toHaveBeenCalled();
    expect(result.imageUrls).toEqual([IMG_URL]);
    expect(result.attachmentLocalPaths).toEqual([null]);
    expect(listFiles(vendorHome)).toEqual([]);
  });

  it('非图片附件下载失败 → download-failed:// 哨兵上报，不伪装成无附件', async () => {
    stubFetch404();
    const { ctx } = makeCtx();

    const result = await processAttachments(
      [{ url: FILE_URL, filename: 'report.pdf', content_type: 'application/pdf' }], ctx);

    expect(result.otherMediaPaths).toEqual(['download-failed://report.pdf']);
    expect(result.attachmentInfo).toBe('');
  });

  it('非图片附件下载成功 → otherMediaPaths 为受管路径（核心整条拒绝），正文 attachmentInfo 为空', async () => {
    stubFetchOk(Buffer.from('%PDF-1.7 fake'), 'application/pdf');
    const { ctx, managedDir } = makeCtx();

    const result = await processAttachments(
      [{ url: FILE_URL, filename: 'report.pdf', content_type: 'application/pdf' }], ctx);

    expect(result.otherMediaPaths).toHaveLength(1);
    expect(path.dirname(result.otherMediaPaths[0])).toBe(managedDir);
    expect(result.attachmentInfo).toBe('');
  });
});

describe('正文卫生', () => {
  it('formatAttachmentTags：纯描述性标签，无 MEDIA:/路径/URL', () => {
    const tags = formatAttachmentTags([
      { type: 'image', filename: 'a.png' },
      { type: 'voice', transcript: '你好' },
      { type: 'voice' },
      { type: 'video' },
      { type: 'file', filename: 'b.pdf' },
      { type: 'unknown' },
    ]);
    expect(tags).toBe(
      '[图片: a.png]\n[语音消息（内容: "你好"）]\n[语音消息]\n[视频]\n[文件: b.pdf]\n[附件]');
    expect(tags).not.toMatch(/MEDIA:/);
  });

  it('formatMessageReferenceForAgent 真实链路：引用图片格式化后立即清理，文本无路径/URL/占位符', async () => {
    stubFetchOk(PNG_MAGIC, 'image/png');
    const { ctx, managedDir, saveMedia } = makeCtx();

    const text = await formatMessageReferenceForAgent(
      { content: '看这张图', attachments: [{ url: IMG_URL, filename: 'photo.png', content_type: 'image/png' }] },
      ctx);

    // 引用附件不移交 dispatch，格式化完成后由连接器立即清理。
    expect(saveMedia).toHaveBeenCalledTimes(1);
    const savedPath = await saveMedia.mock.results[0].value;
    expect(fs.existsSync(savedPath)).toBe(false);
    // 正文卫生：描述性标签，无本地路径 / 远程 URL / MEDIA: 占位符
    expect(text).toContain('看这张图');
    expect(text).toContain('[图片: photo.png]');
    expect(text).not.toContain(managedDir);
    expect(text).not.toContain('198.51.100.7');
    expect(text).not.toMatch(/MEDIA:/);
  });

  it('纯图片消息动态上下文为空：图片/语音不产生计数占位行', () => {
    // 纯图片：无 ASR → dynamicCtx 为 ''，agentBody 保持空正文（content: '' + images）
    expect(buildInboundDynamicContext({ asrReferTexts: [] })).toBe('');
    expect(buildInboundDynamicContext({ asrReferTexts: undefined })).toBe('');
    // 只有作为文本内容的 ASR 参考转写会产生上下文行。
    const ctx = buildInboundDynamicContext({ asrReferTexts: ['你好'] });
    expect(ctx).toBe('- ASR: 你好\n\n');
    expect(ctx).not.toContain('图片');
    expect(ctx).not.toContain('已随消息注入');
  });

  it('formatMessageReferenceForAgent：下载失败哨兵不漏进引用文本', async () => {
    stubFetch404();
    const { ctx } = makeCtx();

    const text = await formatMessageReferenceForAgent(
      { content: '这份文件', attachments: [{ url: FILE_URL, filename: 'report.pdf', content_type: 'application/pdf' }] },
      ctx);

    expect(text).toContain('这份文件');
    expect(text).toContain('[文件: report.pdf]');
    expect(text).not.toContain('download-failed://');
    expect(text).not.toContain('198.51.100.7');
  });
});
