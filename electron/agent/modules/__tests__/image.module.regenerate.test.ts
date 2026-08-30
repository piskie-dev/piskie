/**
 * image 取消采用协作式且有界的动作循环：
 * regenerate 的取消域行为——abort 不得被业务 catch 吞掉后继续发起新外部调用；
 * 调用方 signal 传入 image application port（协作取消能传处传）。
 */
import { describe, it, expect, vi } from 'vitest';



import { ImageModule } from '../image.module.js';
import type { AgentHost } from '../../agent-host.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';

const IMAGE_TARGET = { providerId: 'openai-main', modelId: 'test-model' };

function makeModule(
  chat: (req: unknown, opts: { signal?: AbortSignal }) => Promise<unknown>,
  generate = vi.fn().mockResolvedValue({
    runId: 'test-run',
    model: IMAGE_TARGET,
    configRevision: 1,
    images: [{
      artifactId: 'artifact:test',
      bytes: Buffer.from('hello'),
      mimeType: 'image/png',
    }],
  }),
) {
  const mod = new ImageModule();
  const inference = fakeAgentInference({ invoke: chat as never });
  const host = {
    id: 'agent-test',
    approvalMode: 'confirm',
    currentTarget: { providerId: 'ai-main', modelId: 'chat-main' },
    getInference: () => inference,
    emitStateChange: () => {},
  } as unknown as AgentHost;
  mod.init(host, {
    imageApplication: { execute: generate, hasTarget: () => true },
    imageTarget: IMAGE_TARGET,
  });
  const node = mod.createReviewNode([
    { prompt: 'a cat', outputPath: '/tmp/piskie-test/out.png', overwrite: false },
  ]);
  node.images[0].status = 'completed';   // 重生成的前置状态：已有成功候选
  node.status = 'pending_approval';
  return { mod, generate, node, imageId: node.images[0].id };
}

describe('动作循环 API：abort 中的 regenerate', () => {
  it('prompt 优化 chat 被 abort → 取消上抛、不发起新 generate（裸 catch 不得吞 abort）', async () => {
    const controller = new AbortController();
    const chat = vi.fn().mockImplementation(async (_req: unknown, opts: { signal?: AbortSignal }) => {
      controller.abort();                 // 在途时取消（Stop 的冲程 abort）
      opts.signal?.throwIfAborted();      // provider 协作退出
      return { content: [] };
    });
    const { mod, generate, node, imageId } = makeModule(chat);

    await expect(
      mod.regenerate(node.id, { type: 'regenerate', imageIds: [imageId], instruction: 'make it blue' }, controller.signal),
    ).rejects.toThrow();                  // 取消诚实上抛，不降级为"用原 prompt 继续"

    expect(generate).not.toHaveBeenCalled();   // abort 后不得发起新外部调用
  });

  it('generate 收到调用方 signal，成功后候选版本 +1、节点回到 pending_approval', async () => {
    const chat = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'optimized prompt' }] });
    const { mod, generate, node, imageId } = makeModule(chat);
    const controller = new AbortController();

    await mod.regenerate(node.id, { type: 'regenerate', imageIds: [imageId], instruction: 'x' }, controller.signal);

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ promptCacheKey: 'agent-test' }),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'optimized prompt' }),
      expect.objectContaining({ signal: controller.signal }),
    );
    const img = mod.getNode(node.id)!.images[0];
    expect(img.status).toBe('completed');
    expect(img.version).toBe(1);                       // 成功原子替换候选
    expect(img.candidatePath).toBeTruthy();
    expect(mod.getNode(node.id)!.status).toBe('pending_approval');   // 回到等待下一条动作
  });

  it('generate 失败：保留旧候选只记录错误，节点仍回 pending_approval', async () => {
    const chat = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'optimized prompt' }] });
    const generate = vi.fn().mockRejectedValue(new Error('provider down'));
    const { mod, node, imageId } = makeModule(chat, generate);
    const before = { ...mod.getNode(node.id)!.images[0] };

    await mod.regenerate(node.id, { type: 'regenerate', imageIds: [imageId], instruction: 'x' }, undefined);

    const img = mod.getNode(node.id)!.images[0];
    expect(img.status).toBe('completed');              // 旧候选保留（此前已 completed）
    expect(img.version).toBe(before.version);          // 候选未被替换
    expect(img.error).toContain('provider down');      // 只记录错误
    expect(mod.getNode(node.id)!.status).toBe('pending_approval');
  });
});
