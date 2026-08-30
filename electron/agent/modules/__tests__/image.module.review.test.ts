/**
 * 候选与提交的文件语义，以及 auto 预览行为。
 * 真实文件系统（OS temp）验证：
 * - 多图并发各自写候选；未确认前最终 outputPath 不出现；
 * - 确认后单文件原子提交；重生成后最终路径对应新内容；
 * - 删除项不创建最终文件；MIME 与扩展一致；
 * - partial/failed 语义（已成功正式文件保留、errors 完整、不回 pending）；
 * - overwrite=false 的 TOCTOU 兜底（预检后目标出现 → link 排他失败）；
 * - auto 10 秒自动确认；进入编辑取消 timer 转无限等待；
 * - public state 投影不携带图片 base64。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentHost } from '../../agent-host.js';
import type { ImageApplicationPort } from '../../../inference/application/image-application-port.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));


import { ImageModule } from '../image.module.js';

const HOST_ID = 'agent-review-test';
const OUT_DIR = path.join(os.tmpdir(), 'piskie-test-review-out');
const IMAGE_TARGET = { providerId: 'openai-main', modelId: 'gpt-image-1' };

// 1x1 透明 PNG；变体 B 在尾部追加一字节（PNG 魔数不变，内容不同）
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.concat([PNG_A, Buffer.from([0x00])]);

function makeHost(approvalMode: 'auto' | 'confirm' = 'confirm'): AgentHost {
  const inference = fakeAgentInference({
    invoke: async (_request, options) => ({
      content: [{ type: 'text', text: 'rewritten prompt' }],
      requestInfo: {
        version: 1,
        requestId: options.requestId,
        runId: 'image-rewrite-run',
        model: 'ai-main::chat-main',
        stopReason: 'end_turn',
        latencyMs: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    }),
  });
  return {
    id: HOST_ID,
    approvalMode,
    currentTarget: { providerId: 'ai-main', modelId: 'chat-main' },
    emitStateChange: vi.fn(),
    getInference: () => inference,
  } as unknown as AgentHost;
}

function makeImageApplication(nextB64: () => string): ImageApplicationPort {
  return {
    hasTarget: () => true,
    execute: vi.fn(async () => ({
      runId: 'test-run',
      model: IMAGE_TARGET,
      configRevision: 1,
      images: [{
        artifactId: 'artifact:test',
        bytes: Buffer.from(nextB64(), 'base64'),
        mimeType: 'image/png',
      }],
    })),
  };
}

function setup(opts: { approvalMode?: 'auto' | 'confirm'; b64?: () => string; items?: Array<{ outputPath: string; overwrite?: boolean }> } = {}) {
  const mod = new ImageModule();
  const host = makeHost(opts.approvalMode ?? 'confirm');
  const gateway = makeImageApplication(opts.b64 ?? (() => PNG_A.toString('base64')));
  mod.init(host, { imageApplication: gateway, imageTarget: IMAGE_TARGET });
  const items = (opts.items ?? [{ outputPath: path.join(OUT_DIR, 'a.png') }]).map((it, i) => ({
    prompt: `image ${i}`,
    outputPath: it.outputPath,
    overwrite: it.overwrite ?? false,
  }));
  const node = mod.createReviewNode(items);
  return { mod, node, gateway };
}

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(os.tmpdir(), 'piskie', HOST_ID), { recursive: true, force: true }).catch(() => {});
});

describe('候选与提交文件语义', () => {
  it('多图并发各自写候选；未确认前最终 outputPath 不出现；MIME 与扩展一致', async () => {
    const outA = path.join(OUT_DIR, 'multi-a.png');
    const outB = path.join(OUT_DIR, 'multi-b.png');
    const { mod, node } = setup({ items: [{ outputPath: outA }, { outputPath: outB }] });

    await mod.generateInitialCandidates(node.id);

    for (const img of node.images) {
      expect(img.status).toBe('completed');
      expect(img.candidatePath).toMatch(/\.png$/);        // 扩展来自真实 MIME 检测
      expect(img.candidatePath).toContain(path.join(os.tmpdir(), 'piskie', HOST_ID, 'image-review', node.id));
      expect(img.mimeType).toBe('image/png');
      expect(img.version).toBe(1);
      await expect(fs.readFile(img.candidatePath!)).resolves.toEqual(PNG_A);
    }
    // 候选阶段最终路径不出现
    await expect(fs.access(outA)).rejects.toThrow();
    await expect(fs.access(outB)).rejects.toThrow();
  });

  it('确认后候选原子提交到指定路径，节点随审核会话关闭', async () => {
    const out = path.join(OUT_DIR, 'commit.png');
    const { mod, node } = setup({ items: [{ outputPath: out }] });
    await mod.generateInitialCandidates(node.id);

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('completed');
    expect(outcome.committed[0].outputPath).toBe(out);
    expect(outcome.committed[0].mimeType).toBe('image/png');
    await expect(fs.readFile(out)).resolves.toEqual(PNG_A);
    // 全部提交成功：节点即刻关闭，投影不再含该节点
    expect(mod.getNode(node.id)).toBeUndefined();
    expect(mod.getPublicState()).toHaveLength(0);
  });

  it('重生成后最终路径对应新内容，不再指向旧图片', async () => {
    const out = path.join(OUT_DIR, 'regen.png');
    let current = PNG_A;
    const { mod, node } = setup({ b64: () => current.toString('base64'), items: [{ outputPath: out }] });
    await mod.generateInitialCandidates(node.id);
    const v1 = node.images[0].version;

    current = PNG_B;
    await mod.regenerate(node.id, { type: 'regenerate', imageIds: [node.images[0].id], instruction: '更亮' });
    expect(node.images[0].version).toBe(v1 + 1);
    expect(node.images[0].userInstruction).toBe('更亮');   // 审核干预记录，随 commit 进入最终 tool result
    expect(node.status).toBe('pending_approval');

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('completed');
    await expect(fs.readFile(out)).resolves.toEqual(PNG_B);
  });

  it('删除图片后不创建该项最终文件，deletedCount 计入', async () => {
    const outKeep = path.join(OUT_DIR, 'keep.png');
    const outDrop = path.join(OUT_DIR, 'drop.png');
    const { mod, node } = setup({ items: [{ outputPath: outKeep }, { outputPath: outDrop }] });
    await mod.generateInitialCandidates(node.id);

    node.status = 'pending_approval';   // deleteImage 仅在编辑态开放
    const dropId = node.images[1].id;
    expect(mod.deleteImage(node.id, dropId).success).toBe(true);
    expect(node.deletedCount).toBe(1);

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('completed');
    await expect(fs.readFile(outKeep)).resolves.toEqual(PNG_A);
    await expect(fs.access(outDrop)).rejects.toThrow();
  });

  it('初次生成部分成功、部分失败时允许确认，提交成功项并返回 partial', async () => {
    const outFailed = path.join(OUT_DIR, 'initial-failed.png');
    const outOk = path.join(OUT_DIR, 'initial-ok.png');
    let callCount = 0;
    const { mod, node } = setup({
      b64: () => {
        callCount += 1;
        if (callCount === 1) throw new Error('provider unavailable');
        return PNG_A.toString('base64');
      },
      items: [{ outputPath: outFailed }, { outputPath: outOk }],
    });
    await mod.generateInitialCandidates(node.id);

    expect(node.images.map((image) => image.status)).toEqual(['error', 'completed']);
    const actionPromise = mod.waitForReviewAction(node.id);
    expect(mod.submitReviewAction(node.id, { type: 'approve' }).success).toBe(true);
    await expect(actionPromise).resolves.toEqual({ type: 'approve' });

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('partial');
    expect(outcome.committed.map((image) => image.outputPath)).toEqual([outOk]);
    expect(outcome.errors).toEqual([
      { id: node.images[0].id, outputPath: outFailed, error: 'provider unavailable' },
    ]);
    await expect(fs.readFile(outOk)).resolves.toEqual(PNG_A);
    await expect(fs.access(outFailed)).rejects.toThrow();
  });

  it('初次生成全部失败时直接结算 failed 并关闭节点，不产生正式文件', async () => {
    const out = path.join(OUT_DIR, 'initial-all-failed.png');
    const { mod, node } = setup({
      b64: () => {
        throw new Error('provider unavailable');
      },
      items: [{ outputPath: out }],
    });
    await mod.generateInitialCandidates(node.id);

    expect(node.images[0].status).toBe('error');
    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.committed).toHaveLength(0);
    expect(outcome.errors).toEqual([
      { id: node.images[0].id, outputPath: out, error: 'provider unavailable' },
    ]);
    expect(mod.getNode(node.id)).toBeUndefined();
    expect(mod.getPublicState()).toHaveLength(0);
    await expect(fs.access(out)).rejects.toThrow();
  });

  it('部分提交失败 → partial：成功正式文件保留、errors 完整、候选不清理、不回 pending', async () => {
    const outOk = path.join(OUT_DIR, 'ok.png');
    const outBad = path.join(OUT_DIR, 'bad.png');
    const { mod, node } = setup({ items: [{ outputPath: outOk }, { outputPath: outBad }] });
    await mod.generateInitialCandidates(node.id);

    // 模拟候选被系统临时目录回收
    const badImg = node.images[1];
    await fs.unlink(badImg.candidatePath!);

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('partial');
    expect(outcome.committed).toHaveLength(1);
    expect(outcome.errors).toEqual([
      { id: badImg.id, outputPath: outBad, error: expect.stringContaining('候选文件不可读取') },
    ]);
    await expect(fs.readFile(outOk)).resolves.toEqual(PNG_A);   // 已成功正式文件保留
    await expect(fs.access(outBad)).rejects.toThrow();
    expect(node.status).toBe('partial');                        // 终态，不回 pending
    // 成功项候选不做清理（零清理）
    await expect(fs.access(node.images[0].candidatePath!)).resolves.toBeUndefined();
  });

  it('overwrite=false 的 TOCTOU 兜底：预检后目标出现 → 排他创建失败 → failed', async () => {
    const out = path.join(OUT_DIR, 'toctou.png');
    const { mod, node } = setup({ items: [{ outputPath: out }] });
    await mod.generateInitialCandidates(node.id);

    // commit 预检之后、link 之前无法插入——直接以"已存在"进入 commit 覆盖预检路径
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(out, 'pre-existing');

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('failed');
    expect(outcome.errors[0].error).toContain('已存在');
    await expect(fs.readFile(out, 'utf-8')).resolves.toBe('pre-existing');   // 原文件未被覆盖
    expect(mod.getNode(node.id)).toBeUndefined();
  });

  it('overwrite=true 原子覆盖既有文件', async () => {
    const out = path.join(OUT_DIR, 'overwrite.png');
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(out, 'old content');
    const { mod, node } = setup({ items: [{ outputPath: out, overwrite: true }] });
    await mod.generateInitialCandidates(node.id);

    const outcome = await mod.commit(node.id);
    expect(outcome.status).toBe('completed');
    await expect(fs.readFile(out)).resolves.toEqual(PNG_A);
  });
});

describe('auto 预览倒计时', () => {
  it('auto 首轮 10 秒后自动 approve（与手动确认同路）', async () => {
    vi.useFakeTimers();
    const { mod, node } = setup({ approvalMode: 'auto' });

    const actionPromise = mod.waitForReviewAction(node.id);
    expect(node.status).toBe('preview');
    expect(node.previewDeadline).toBeGreaterThan(Date.now());

    vi.advanceTimersByTime(10_000);
    await expect(actionPromise).resolves.toEqual({ type: 'approve' });
  });

  it('auto 期间进入编辑取消 timer，转无限等待直到显式动作', async () => {
    vi.useFakeTimers();
    const { mod, node } = setup({ approvalMode: 'auto' });

    const actionPromise = mod.waitForReviewAction(node.id);
    expect(mod.enterImageEdit(node.id).success).toBe(true);
    expect(node.status).toBe('pending_approval');

    // 倒计时已取消：时间流逝不产生自动 approve
    vi.advanceTimersByTime(60_000);
    const settled = await Promise.race([actionPromise.then(() => true), Promise.resolve(false)]);
    expect(settled).toBe(false);

    // 显式动作照常结算
    expect(mod.submitReviewAction(node.id, { type: 'cancel', reason: '不要了' }).success).toBe(true);
    await expect(actionPromise).resolves.toEqual({ type: 'cancel', reason: '不要了' });
  });

  it('confirm 模式不进入 preview，直接 pending_approval 无限等待', async () => {
    const { mod, node } = setup({ approvalMode: 'confirm' });
    const actionPromise = mod.waitForReviewAction(node.id);
    expect(node.status).toBe('pending_approval');
    expect(node.previewDeadline).toBeUndefined();
    mod.submitReviewAction(node.id, { type: 'cancel' });
    await expect(actionPromise).resolves.toEqual({ type: 'cancel' });
  });
});

describe('public state 投影不携带 base64', () => {
  it('getPublicState 字段是白名单投影，无图片数据字段', async () => {
    const { mod, node } = setup();
    await mod.generateInitialCandidates(node.id);

    const [pub] = mod.getPublicState();
    expect(pub.id).toBe(node.id);
    expect(Object.keys(pub.images[0]).sort()).toEqual(
      ['candidatePath', 'error', 'id', 'mimeType', 'outputPath', 'prompt', 'status', 'version'].sort(),
    );
    const serialized = JSON.stringify(mod.getPublicState());
    expect(serialized).not.toContain('"b64":');
    expect(serialized).not.toContain('"base64":');
    expect(serialized).not.toContain(PNG_A.toString('base64').slice(0, 24));
  });
});
