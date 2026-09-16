/**
 * generate_image 工具契约。
 * - 预检全部发生在任何 Provider 请求/审核节点创建之前；
 * - schema 与 execute 双层强制 1-10 张；
 * - 审核动作循环：regenerate 回到等待、approve 提交、cancel 普通业务失败；
 * - completed/partial/failed/cancelled 结果语义。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sample-app-test' },
}));


import { GenerateImageTool } from '../generate-image.tool.js';
import type { ImageReviewOps, ImageReviewAction, ImageCommitOutcome } from '../image-review-types.js';
import type { ToolContext, ToolOutput } from '../../types.js';
import { parse, toApiSchema } from '../../params.js';
import type { ImageNodeState } from '../../../../shared/types/index.js';
import { generatedImagePaths } from '../../../../shared/tool-images.js';

function makeOps(overrides: Partial<ImageReviewOps> = {}): ImageReviewOps {
  const node = { id: 'node-1', deletedCount: 0, images: [] } as unknown as ImageNodeState;
  return {
    isConfigured: () => true,
    createReviewNode: vi.fn(() => node),
    generateInitialCandidates: vi.fn(async () => {}),
    waitForReviewAction: vi.fn(async (): Promise<ImageReviewAction> => ({ type: 'approve' })),
    regenerate: vi.fn(async () => {}),
    commit: vi.fn(async (): Promise<ImageCommitOutcome> => ({ status: 'completed', committed: [], errors: [] })),
    cancelReview: vi.fn(),
    getNode: vi.fn(() => node),
    ...overrides,
  };
}

function makeContext(ops?: ImageReviewOps, signal?: AbortSignal): ToolContext {
  return {
    imageOps: ops,
    signal: signal ?? new AbortController().signal,
  } as unknown as ToolContext;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let outputDir: string;

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-image-output-'));
});

const img = (i: number, extra: Record<string, unknown> = {}) => ({
  prompt: `image ${i}`,
  outputPath: path.join(outputDir, `out-${i}.png`),
  ...extra,
});

describe('schema 双层强制', () => {
  it('模型说明只交代使用时机、入参方式和 prompt 编写要求', () => {
    const tool = new GenerateImageTool();
    const schema = toApiSchema(tool.def.schema);
    const images = schema.properties.images as Record<string, unknown>;
    const item = images.items as Record<string, unknown>;
    const properties = item.properties as Record<string, { description?: string }>;

    expect(tool.def.description).toBe(
      '需要生成一张或多张图片时调用。通过 images 提交要生成的图片，' +
      '每张图片指定 prompt 和最终文件的绝对路径 outputPath。',
    );
    expect(properties.prompt.description).toBe(
      '可直接用于图片生成的描述。准确保留用户要求，使用英文按需写明主体、场景、构图、风格、光线、色彩和质感；需要出现在画面中的文字保持用户指定原文',
    );
  });

  it('schema 声明 images minItems=1 / maxItems=10，outputPath+prompt 必填', () => {
    const schema = toApiSchema(new GenerateImageTool().def.schema);
    const images = schema.properties.images as Record<string, unknown>;
    expect(images.minItems).toBe(1);
    expect(images.maxItems).toBe(10);
    expect((images.items as Record<string, unknown>).required).toEqual(['prompt', 'outputPath']);
  });

  it('overwrite 的字符串 false 按统一 bool 契约解析为 false', () => {
    const result = parse(new GenerateImageTool().def.schema, {
      images: [img(1, { overwrite: 'false' })],
    });

    expect(result).toEqual({
      ok: true,
      value: { images: [img(1, { overwrite: false })] },
    });
  });
});

describe('预检发生在任何 Provider 请求之前', () => {
  let tool: GenerateImageTool;
  let ops: ImageReviewOps;

  beforeEach(() => {
    tool = new GenerateImageTool();
    ops = makeOps();
  });

  async function expectPreflightError(params: Record<string, unknown>, fragment: string) {
    const result = await tool.execute(params as never, makeContext(ops)) as ToolOutput<unknown>;
    expect(result.ok).toBe(false);
    expect(result.text).toContain(fragment);
    expect(ops.createReviewNode).not.toHaveBeenCalled();
    expect(ops.generateInitialCandidates).not.toHaveBeenCalled();
  }

  it('无 imageOps → 模块未启用错误', async () => {
    const result = await tool.execute({ images: [img(1)] }, makeContext(undefined)) as ToolOutput<unknown>;
    expect(result.ok).toBe(false);
    expect(result.text).toContain('图片模块');
  });

  it('未配置供应商 → 引导到生图配置，且不创建节点', async () => {
    ops = makeOps({ isConfigured: () => false });
    await expectPreflightError({ images: [img(1)] }, '生图配置');
  });

  it('images 缺失 / 空数组由 Coordinator 的唯一 schema parse 拒绝', () => {
    expect(parse(tool.def.schema, {}).ok).toBe(false);
    expect(parse(tool.def.schema, { images: [] }).ok).toBe(false);
  });

  it('11 张 → 任何 Provider 请求前整体拒绝；schema 被绕过时 execute 层仍拒绝', async () => {
    await expectPreflightError(
      { images: Array.from({ length: 11 }, (_, i) => img(i)) },
      '最多生成 10 张',
    );
  });

  it('缺 prompt / 缺 outputPath / 相对路径 → 逐项定位错误', async () => {
    await expectPreflightError({ images: [{ outputPath: '/tmp/a.png' }] }, 'prompt');
    await expectPreflightError({ images: [{ prompt: 'x' }] }, 'outputPath');
    await expectPreflightError({ images: [{ prompt: 'x', outputPath: 'relative/a.png' }] }, '绝对路径');
  });

  it('同批重复路径（含归一化后相同）在生成前失败', async () => {
    const p = path.join(outputDir, 'dup.png');
    await expectPreflightError(
      { images: [{ prompt: 'a', outputPath: p }, { prompt: 'b', outputPath: path.join(outputDir, '.', 'dup.png') }] },
      '重复',
    );
  });

  it('overwrite=false 且目标已存在 → 生成前失败；overwrite=true 放行', async () => {
    const existing = path.join(outputDir, 'existing.png');
    await fs.writeFile(existing, 'old');
    try {
      await expectPreflightError({ images: [{ prompt: 'x', outputPath: existing }] }, '已存在');

      const result = await tool.execute(
        { images: [{ prompt: 'x', outputPath: existing, overwrite: true }] },
        makeContext(ops),
      ) as ToolOutput<unknown>;
      expect(ops.createReviewNode).toHaveBeenCalledWith([
        { prompt: 'x', size: undefined, outputPath: existing, overwrite: true },
      ]);
      expect(result.ok).toBe(true);
    } finally {
      await fs.unlink(existing).catch(() => {});
    }
  });

  it('1 张与 10 张正常进入生成', async () => {
    await tool.execute({ images: [img(1)] }, makeContext(ops));
    expect(vi.mocked(ops.createReviewNode).mock.calls[0][0]).toHaveLength(1);

    const ops10 = makeOps();
    await tool.execute({ images: Array.from({ length: 10 }, (_, i) => img(i)) }, makeContext(ops10));
    expect(vi.mocked(ops10.createReviewNode).mock.calls[0][0]).toHaveLength(10);
  });
});

describe('审核动作循环与最终结果', () => {
  const committedItem = (i: number) => ({
    id: `img-${i}`,
    outputPath: path.join(outputDir, `final-${i}.png`),
    mimeType: 'image/png',
    prompt: `image ${i}`,
  });

  async function commitOutcome(outcome: ImageCommitOutcome, bytes = PNG): Promise<ImageCommitOutcome> {
    await Promise.all(outcome.committed.map((item) => fs.writeFile(item.outputPath, bytes)));
    return outcome;
  }

  it('presentation reads only committed paths from the actual tool result, including multiline paths and notes', async () => {
    const outputPath = path.join(outputDir, '示例（图片）\n"one".png');
    const note = 'A sample revision\n- [成功] "/output/unrelated.png"';
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({
        status: 'partial' as const,
        committed: [{ ...committedItem(1), outputPath, userInstruction: note }],
        errors: [{ id: 'img-2', outputPath: '/output/failed.png', error: note }],
      })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1), img(2)] }, makeContext(ops)) as ToolOutput<unknown>;
    expect(result.ok).toBe(false);
    expect(generatedImagePaths('generate_image', result.text)).toEqual([outputPath]);
  });

  it('approve returns the committed image bytes and concise status/path text', async () => {
    const committed = { ...committedItem(1), revisedPrompt: 'Sample optimized prompt' };
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({ status: 'completed', committed: [committed], errors: [] })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops));
    expect(result.ok).toBe(true);
    expect(result.text).toBe(`图片生成完成：1 张已写入最终路径。\n- [成功] ${JSON.stringify(committed.outputPath)}`);
    expect(result.images).toEqual([{ base64: PNG.toString('base64'), mediaType: 'image/png' }]);
    expect(result.data).toMatchObject({ status: 'completed', images: [committed] });
    expect(ops.commit).toHaveBeenCalledOnce();
  });

  it('returns every committed image in order with its actual MIME type', async () => {
    const committed = [committedItem(1), { ...committedItem(2), mimeType: 'image/gif' }];
    const ops = makeOps({
      commit: vi.fn(async () => {
        await fs.writeFile(committed[0].outputPath, PNG);
        await fs.writeFile(committed[1].outputPath, GIF);
        return { status: 'completed', committed, errors: [] };
      }),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1), img(2)] }, makeContext(ops));
    expect(result.ok).toBe(true);
    expect(result.images).toEqual([
      { base64: PNG.toString('base64'), mediaType: 'image/png' },
      { base64: GIF.toString('base64'), mediaType: 'image/gif' },
    ]);
    expect(generatedImagePaths('generate_image', result.text)).toEqual(committed.map((item) => item.outputPath));
  });

  it('returns images larger than the read tool limit without truncation', async () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({ status: 'completed', committed: [committedItem(1)], errors: [] }, bytes)),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops));
    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images![0].base64, 'base64').equals(bytes)).toBe(true);
  });

  it('completed 结果回显用户审核干预，防止 AI 把用户改动当问题返工', async () => {
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({
        status: 'completed' as const,
        committed: [{ ...committedItem(1), userInstruction: '把背景改成日落' }],
        errors: [],
      })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops)) as ToolOutput<unknown>;
    expect(result.ok).toBe(true);
    expect(result.images).toEqual([{ base64: PNG.toString('base64'), mediaType: 'image/png' }]);
    expect(result.text).toContain('用户在审核中要求修改：「把背景改成日落」');
  });

  it('regenerate 动作回到等待循环，最终 approve 只产生一个结果', async () => {
    const actions: ImageReviewAction[] = [
      { type: 'regenerate', imageIds: ['img-1'], instruction: '更亮' },
      { type: 'regenerate', imageIds: ['img-1'], instruction: '更暗' },
      { type: 'approve' },
    ];
    const ops = makeOps({
      waitForReviewAction: vi.fn(async () => actions.shift()!),
      commit: vi.fn(async () => commitOutcome({ status: 'completed' as const, committed: [committedItem(1)], errors: [] })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops)) as ToolOutput<unknown>;
    expect(ops.regenerate).toHaveBeenCalledTimes(2);
    expect(ops.commit).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('初次生成全部失败时直接返回 failed，不进入无限审核等待', async () => {
    const outputPath = img(1).outputPath as string;
    const failedNode = {
      id: 'node-all-failed',
      agentId: 'agent-1',
      status: 'generating',
      createdAt: new Date(),
      deletedCount: 0,
      images: [{
        id: 'img-failed',
        prompt: 'image 1',
        outputPath,
        overwrite: false,
        status: 'error',
        version: 0,
        error: 'fetch failed',
      }],
    } as ImageNodeState;
    const ops = makeOps({
      createReviewNode: vi.fn(() => failedNode),
      commit: vi.fn(async () => commitOutcome({
        status: 'failed' as const,
        committed: [],
        errors: [{ id: 'img-failed', outputPath, error: 'fetch failed' }],
      })),
      getNode: vi.fn(() => failedNode),
    });

    const result = await new GenerateImageTool().execute(
      { images: [img(1)] },
      makeContext(ops),
    ) as ToolOutput<unknown>;

    expect(result.ok).toBe(false);
    expect((result.data as { status: string }).status).toBe('failed');
    expect(result.images).toBeUndefined();
    expect(result.text).toContain('fetch failed');
    expect(ops.commit).toHaveBeenCalledOnce();
    expect(ops.waitForReviewAction).not.toHaveBeenCalled();
  });

  it('partial：success:false，errors 列表完整、已成功路径回显、不回到 pending', async () => {
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({
        status: 'partial' as const,
        committed: [committedItem(1), committedItem(3)],
        errors: [{ id: 'img-2', outputPath: img(2).outputPath, error: '目标文件已存在且未允许覆盖' }],
      })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1), img(2), img(3)] }, makeContext(ops));
    expect(result.ok).toBe(false);
    expect(result.text).toContain('部分');
    expect(result.text).toContain('目标文件已存在且未允许覆盖');
    expect(result.images).toEqual([
      { base64: PNG.toString('base64'), mediaType: 'image/png' },
      { base64: PNG.toString('base64'), mediaType: 'image/png' },
    ]);
    expect(generatedImagePaths('generate_image', result.text)).toEqual([committedItem(1).outputPath, committedItem(3).outputPath]);
    const data = result.data as { status: string; images: unknown[]; errors: unknown[] };
    expect(data.status).toBe('partial');
    expect(data.images).toHaveLength(2);
    expect(data.errors).toHaveLength(1);
    expect(ops.waitForReviewAction).toHaveBeenCalledOnce();   // 不回到 pending
  });

  it('failed：全部失败 → success:false 且 images 为空', async () => {
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({
        status: 'failed' as const,
        committed: [],
        errors: [{ id: 'img-1', outputPath: '/tmp/x.png', error: '候选文件不可读取' }],
      })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops)) as ToolOutput<unknown>;
    expect(result.ok).toBe(false);
    expect((result.data as { images: unknown[] }).images).toHaveLength(0);
    expect(result.images).toBeUndefined();
    expect(result.text).toContain('候选文件不可读取');
  });

  it('cancel：普通业务失败（Agent 继续），节点结算 cancelled、无文件操作', async () => {
    const ops = makeOps({
      waitForReviewAction: vi.fn(async (): Promise<ImageReviewAction> => ({ type: 'cancel', reason: '不需要了' })),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops)) as ToolOutput<unknown>;
    expect(result.ok).toBe(false);
    expect((result.data as { status: string }).status).toBe('cancelled');
    expect(result.images).toBeUndefined();
    expect(result.text).toBe('用户取消了本次图片生成（不需要了），未创建任何正式文件。');
    expect(ops.cancelReview).toHaveBeenCalledWith('node-1', '不需要了');
    expect(ops.commit).not.toHaveBeenCalled();
  });

  it('reports a file removed after commit while preserving saved paths and other images', async () => {
    const committed = [committedItem(1), committedItem(2)];
    const ops = makeOps({
      commit: vi.fn(async () => {
        const outcome = await commitOutcome({ status: 'completed', committed, errors: [] });
        await fs.unlink(committed[0].outputPath);
        return outcome;
      }),
    });
    const result = await new GenerateImageTool().execute({ images: [img(1), img(2)] }, makeContext(ops));
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ status: 'completed', images: committed, errors: [] });
    expect(result.text).toContain('2 张已写入最终路径');
    expect(result.text).toContain(`- [图片回传失败] ${JSON.stringify(committed[0].outputPath)}:`);
    expect(result.text).toContain('ENOENT');
    expect(generatedImagePaths('generate_image', result.text)).toEqual(committed.map((item) => item.outputPath));
    expect(result.images).toEqual([{ base64: PNG.toString('base64'), mediaType: 'image/png' }]);
  });

  it('propagates abort while reading committed images', async () => {
    const controller = new AbortController();
    const ops = makeOps({
      commit: vi.fn(async () => commitOutcome({ status: 'completed', committed: [committedItem(1)], errors: [] })),
    });
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => {
      controller.abort(new Error('user stop'));
      throw controller.signal.reason;
    });
    await expect(
      new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops, controller.signal)),
    ).rejects.toThrow('user stop');
  });

  it('审核动作返回后 signal 已 abort → 原样上抛，不构建业务结果（防御层）', async () => {
    const controller = new AbortController();
    const ops = makeOps({
      waitForReviewAction: vi.fn(async (): Promise<ImageReviewAction> => {
        controller.abort(new Error('user stop'));
        return { type: 'approve' };
      }),
    });
    await expect(
      new GenerateImageTool().execute({ images: [img(1)] }, makeContext(ops, controller.signal)),
    ).rejects.toThrow();
    expect(ops.commit).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(outputDir, { recursive: true, force: true });
});
