/**
 * 生图审核动作循环的生命周期。
 * 真实 AgentEngine（destroy/interrupt 本体）+ 真实 ImageModule + 冲程内模拟工具，锁定：
 * - 审核 pending（挂起动作 Promise）时 destroy：cancelInFlightWork reject 挂起动作
 *   → 工具退出 → pump settle 后 destroy 完成；
 * - destroy 之后审核动作 IPC 被拒收；
 * - interrupt 取消在途重生成请求（context.signal 传导到 gateway，abort 不吞成单图 error）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentControlState, ConversationEntry } from '../../../../shared/types/agent-control.js';
import type { AgentInputEvent } from '../../../../shared/types/index.js';
import type { AgentHost } from '../../agent-host.js';
import type { ImageApplicationPort } from '../../../inference/application/image-application-port.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));


import { AgentEngine, type TurnOutcome } from '../../agent-engine.js';
import { ImageModule } from '../image.module.js';

const flush = () => new Promise<void>((r) => setImmediate(r));
const IMAGE_TARGET = { providerId: 'openai-main', modelId: 'gpt-image-1' };

/** 最小真实引擎：destroy/interrupt/pump 走 AgentEngine 本体，冲程体由测试注入 */
class ImageLoopEngine extends AgentEngine {
  mod?: ImageModule;
  turnImpl?: (signal: AbortSignal) => Promise<TurnOutcome>;

  constructor() {
    super();
    this.id = 'agent-img';
    this.mainAgentId = this.id;
    this.currentModel = 'ai-main::chat-main';
    this.currentTarget = { providerId: 'ai-main', modelId: 'chat-main' };
    this.inference = fakeAgentInference();
    this.context = {
      flush: vi.fn(),
      setModel: vi.fn(),
      addUserMessage: vi.fn(),
      getAllMessages: () => [],
    } as never;
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  protected appendConversationEntry(_entry: ConversationEntry): void {}
  protected override async runTurn(signal: AbortSignal): Promise<TurnOutcome> {
    if (this.turnImpl) return this.turnImpl(signal);
    return {};
  }

  /** 复刻 AgentRuntime.cancelInFlightWork 接线形状：interrupt/destroy 同步前缀通知模块 */
  protected override cancelInFlightWork(): void {
    try {
      this.mod?.onInterrupt();
    } catch {
      // 单模块失败不阻断
    }
  }

  protected override collectDestroyTasks(): Array<Promise<unknown>> {
    return this.mod ? [this.mod.onDestroy()] : [];
  }
}

function makeHost(engine: ImageLoopEngine): AgentHost {
  const inference = fakeAgentInference({
    invoke: async (_request, options) => ({
      content: [{ type: 'text', text: 'a brighter cat' }],
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
    id: engine.id,
    approvalMode: 'confirm',
    currentTarget: { providerId: 'ai-main', modelId: 'chat-main' },
    emitStateChange: () => {},
    getInference: () => inference,
  } as unknown as AgentHost;
}

/** gateway 替身：挂起直到收 signal abort，abort 后延迟 settle（退出 ≠ 瞬时） */
function hangingGenerate(signals: AbortSignal[], settledFlag: { value: boolean }, delayMs = 20) {
  return (_req: unknown, opts?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      const signal = opts?.signal;
      if (!signal) return rej(new Error('signal 未传入 gateway，接线断裂'));
      signals.push(signal);
      if (signal.aborted) return rej(signal.reason);
      signal.addEventListener('abort', () => {
        setTimeout(() => { settledFlag.value = true; rej(signal.reason); }, delayMs);
      }, { once: true });
    });
}

function makeImageApplication(
  generate: (req: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>,
): ImageApplicationPort {
  return {
    hasTarget: () => true,
    execute: generate,
  } as ImageApplicationPort;
}

function setup(generate: (req: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>) {
  const engine = new ImageLoopEngine();
  const mod = new ImageModule();
  mod.init(makeHost(engine), {
    imageApplication: makeImageApplication(generate),
    imageTarget: IMAGE_TARGET,
  });
  engine.mod = mod;
  const node = mod.createReviewNode([
    { prompt: 'a cat', outputPath: '/tmp/piskie-test/cat.png', overwrite: false },
  ]);
  return { engine, mod, node };
}

describe('审核动作循环生命周期', () => {
  it('审核 pending 时 destroy：挂起动作 Promise 被 reject → 工具退出 → pump settle 后 destroy 完成', async () => {
    const { engine, mod, node } = setup(vi.fn());
    let toolExited = false;

    engine.turnImpl = async () => {
      // 模拟 generate_image：在冲程内等待审核动作（用户确认前 Promise 不 settle）
      await expect(mod.waitForReviewAction(node.id)).rejects.toThrow('中断');
      toolExited = true;
      return {};
    };
    engine.post({ id: 'e1', source: 'user', content: 'go' });
    await vi.waitFor(() => expect(mod.getNode(node.id)?.status).toBe('pending_approval'));
    expect(engine.isPumping).toBe(true);   // 审核 pending = 冲程在途，下一次 AI 请求不会发生

    await engine.destroy();
    expect(toolExited).toBe(true);         // destroy 完成时冲程必已 settle
    expect(engine.isPumping).toBe(false);
  });

  it('destroy 之后审核动作 IPC 被拒收（success: false），节点已结算', async () => {
    const { engine, mod, node } = setup(vi.fn());
    engine.turnImpl = async () => {
      await mod.waitForReviewAction(node.id).catch(() => undefined);
      return {};
    };
    engine.post({ id: 'e1', source: 'user', content: 'go' });
    await vi.waitFor(() => expect(mod.getNode(node.id)?.status).toBe('pending_approval'));

    await engine.destroy();
    const result = mod.submitReviewAction(node.id, { type: 'approve' });
    expect(result.success).toBe(false);
    // onInterrupt 已把非终态节点结算为 cancelled（终态出口，不回 pending）
    // onDestroy 随后清空 imageNodes——两种观测都属拒收
  });

  it('interrupt 取消在途重生成：context.signal 传导到 gateway，abort 上抛不吞成单图 error', async () => {
    const genSignals: AbortSignal[] = [];
    const genSettled = { value: false };
    const { engine, mod, node } = setup(hangingGenerate(genSignals, genSettled));
    const imageId = mod.getNode(node.id)!.images[0].id;

    let regenerateRejected = false;
    engine.turnImpl = async (signal) => {
      // 模拟 generate_image 审核循环：重生成在原工具 Promise 内、统一使用冲程 signal
      try {
        await mod.regenerate(node.id, { type: 'regenerate', imageIds: [imageId], instruction: '改亮一点' }, signal);
      } catch {
        regenerateRejected = true;
      }
      return {};
    };
    engine.post({ id: 'e1', source: 'user', content: 'go' });
    await vi.waitFor(() => expect(genSignals.length).toBe(1));   // prompt 改写完成后已推进到 generate
    expect(genSignals[0].aborted).toBe(false);

    await engine.interrupt();
    expect(genSignals[0].aborted).toBe(true);      // 冲程 signal 直达 gateway 请求
    expect(genSettled.value).toBe(true);           // interrupt 返回 = 旧冲程已 settle，在途请求真实退出
    expect(regenerateRejected).toBe(true);         // abort 诚实上抛，不降级为 error item
    expect(mod.getNode(node.id)?.status).toBe('cancelled');   // onInterrupt 结算节点
  });

  it('interrupt 后迟到的等待请求不创建孤儿 pending：waitForReviewAction 对已结算节点直接 reject', async () => {
    const { engine, mod, node } = setup(vi.fn());
    engine.turnImpl = async () => {
      await mod.waitForReviewAction(node.id).catch(() => undefined);
      return {};
    };
    engine.post({ id: 'e1', source: 'user', content: 'go' });
    await vi.waitFor(() => expect(mod.getNode(node.id)?.status).toBe('pending_approval'));

    await engine.interrupt();
    expect(mod.getNode(node.id)?.status).toBe('cancelled');
    await expect(mod.waitForReviewAction(node.id)).rejects.toThrow('已结束');
    await flush();
  });
});
