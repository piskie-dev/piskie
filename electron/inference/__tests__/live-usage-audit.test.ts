/**
 * per-provider 用量对拍（最后一张表）。
 *
 * 这里测的东西单元测试测不了。单元测试喂假 usage 进 `normalizeUsage`，验证的是
 * 「代码按我理解的规则执行了」；而缓存计量 bug 的成因恰恰是**理解错了规则**——
 * 把 Anthropic 的 `input_tokens` 当成已含缓存，于是缓存命中时上下文数字骤降。
 * 那种错误在假数据下永远绿。
 *
 * 所以这个文件向真实 provider 发请求，走完整生产链路
 * （真实配置 → `compileInferenceConfig` → driver `openAttempt` → `normalizeUsage`），
 * 再用**不依赖我的理解**的判据去校验：
 *
 * - Anthropic 协议：同一份输入，缓存命中前后 `totalInputTokens` 必须相等。
 *   内容没变，模型处理的量就没变；变的只是哪一部分走了缓存。
 * - OpenAI 协议：`totalInputTokens + totalOutputTokens` 必须等于 provider 自报的
 *   `total_tokens`。这是 provider 自己算的总数，与我怎么读文档无关。
 *
 * 默认跳过（要花钱、要网络）。跑法：
 *   LIVE_USAGE_AUDIT=1 npx vitest run electron/inference/__tests__/live-usage-audit.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CanonicalCatalogSource } from '../catalog/canonical-source.js';
import { createBuiltInInferenceDriverRegistry } from '../composition/built-in-drivers.js';
import { inferenceConfigSchema } from '../control/config-schema.js';
import { compileInferenceConfig } from '../control/compiler.js';
import { findCompiledTarget } from '../execution/runtime-snapshot.js';
import type { AiRequest, AiUsage } from '../ai/contracts.js';
import type { AttemptContext } from '../execution/contracts.js';

const ENABLED = process.env.LIVE_USAGE_AUDIT === '1';
const ROOT = path.join(os.homedir(), '.piskie');

/** 供 driver 构造用的最小桩：本对拍不涉及图片与工作流资产。 */
const STUB = {
  artifacts: {
    read: () => { throw new Error('artifact read not expected in usage audit'); },
    write: () => { throw new Error('artifact write not expected in usage audit'); },
    info: () => { throw new Error('artifact info not expected in usage audit'); },
  },
  workflows: {},
} as never as Parameters<typeof createBuiltInInferenceDriverRegistry>[0];

/** 抓 provider 原始响应体，用于与生产代码算出的 usage 交叉核对。 */
interface RawCapture { bodies: string[] }

function capturingFetch(capture: RawCapture): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input as string, init);
    if (!response.body) return response;
    const [forDriver, forCapture] = response.body.tee();
    void (async () => {
      let text = '';
      const reader = forCapture.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      capture.bodies.push(text);
    })();
    return new Response(forDriver, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function loadRuntime(capture: RawCapture) {
  const catalog = await new CanonicalCatalogSource({ rootDirectory: ROOT }).load();
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'inference.json'), 'utf8'));
  const config = inferenceConfigSchema.parse(raw);
  const fetchImpl = capturingFetch(capture);
  const drivers = createBuiltInInferenceDriverRegistry({
    ...STUB,
    openAi: { fetch: fetchImpl },
    anthropic: { fetch: fetchImpl },
  });
  return compileInferenceConfig(config, catalog, drivers);
}

interface Candidate {
  ai: NonNullable<ReturnType<typeof findCompiledTarget>>['ai'];
  ref: { providerId: string; modelId: string };
  label: string;
}

/**
 * 列出某个 driver 下的全部候选目标，**不写死任何 provider 或模型名**。
 *
 * 判据是协议级的（「anthropic 协议下缓存要相加」），与具体哪一家无关；而
 * provider 名、模型名、provider ID 全是各人本机配置里的东西，写进测试就
 * 等于让这个文件只能在一台机器上跑。
 *
 * 想指定用哪家，设 `LIVE_AUDIT_PROVIDER`（provider 显示名，逗号分隔多个，
 * 按给定顺序优先）。不设则把该 driver 的所有目标依次试过去——配置里第一个
 * 不一定跑得通（模型不被端点支持、额度用尽等）。
 */
async function listCandidates(driverId: string, capture: RawCapture): Promise<Candidate[]> {
  const snapshot = await loadRuntime(capture);
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'inference.json'), 'utf8'));
  const nameOf = (providerId: string): string =>
    (raw.providers as Record<string, { displayName?: string }>)[providerId]?.displayName ?? providerId;

  const preferred = (process.env.LIVE_AUDIT_PROVIDER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidates: Candidate[] = [];
  for (const [providerId, models] of snapshot.targets) {
    for (const [modelId, compiled] of models) {
      if (compiled.driverId !== driverId || !compiled.ai) continue;
      candidates.push({
        ai: compiled.ai,
        ref: { providerId, modelId },
        label: `${nameOf(providerId)} / ${modelId} / ${driverId}`,
      });
    }
  }
  if (preferred.length === 0) return candidates;
  const rank = (c: Candidate): number => {
    const at = preferred.indexOf(nameOf(c.ref.providerId));
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return candidates.filter((c) => rank(c) !== Number.MAX_SAFE_INTEGER).sort((a, b) => rank(a) - rank(b));
}

/** 依次试候选，返回第一个跑通的；全都不通就把每一个的失败原因如实带出来。 */
async function firstWorking<T>(
  candidates: readonly Candidate[],
  attempt: (candidate: Candidate) => Promise<T>,
): Promise<{ candidate: Candidate; value: T } | { failures: string[] }> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return { candidate, value: await attempt(candidate) };
    } catch (error) {
      failures.push(`${candidate.label}: ${(error as Error).message.slice(0, 160)}`);
    }
  }
  return { failures };
}

function attemptContext(): AttemptContext {
  return {
    runId: 'usage-audit',
    traceId: 'usage-audit',
    signal: AbortSignal.timeout(120_000),
    attempt: 1,
    configRevision: 0,
    connectTimeoutMs: 60_000,
  };
}

/** 跑一轮真实请求，返回生产代码归一化后的 usage。 */
async function runOnce(
  ai: { openAttempt(request: AiRequest, context: AttemptContext): AsyncIterable<{ kind: string }> },
  request: AiRequest,
): Promise<AiUsage> {
  let usage: AiUsage = {};
  for await (const event of ai.openAttempt(request, attemptContext())) {
    if (event.kind === 'usage.updated') usage = { ...usage, ...(event as { usage: AiUsage }).usage };
  }
  return usage;
}

/**
 * 把原始字段与归一化结果并排打出来。跑这个文件的人要的就是这两行数——
 * 绿灯只说明断言成立，看不出两家的语义到底相反在哪。
 */
function report(label: string, usages: readonly AiUsage[], capture: RawCapture): void {
  const raw = extractUsageObjects(capture.bodies.join('')).slice(-usages.length);
  console.log(`\n── ${label} ──`);
  usages.forEach((usage, index) => {
    console.log(`  provider 原始 : ${raw[index] ?? '(未抓到)'}`);
    console.log(`  归一化结果   : ${JSON.stringify(usage)}`);
  });
}

/** 按括号配对切出每个 `"usage":{...}`——Anthropic 是扁平的、OpenAI 带嵌套，正则做不到。 */
function extractUsageObjects(text: string): string[] {
  const found: string[] = [];
  for (let at = text.indexOf('"usage":'); at !== -1; at = text.indexOf('"usage":', at + 1)) {
    const start = text.indexOf('{', at);
    if (start === -1) break;
    let depth = 0;
    for (let cursor = start; cursor < text.length; cursor++) {
      if (text[cursor] === '{') depth++;
      else if (text[cursor] === '}' && --depth === 0) {
        found.push(text.slice(start, cursor + 1));
        break;
      }
    }
  }
  return found;
}

/** 足够长且完全固定的前缀——缓存要命中，前缀必须逐字节一致。 */
const STABLE_PREFIX = '你是一个严谨的软件工程助手。以下是项目背景说明，请完整记住。'.repeat(120);

describe.skipIf(!ENABLED)('per-provider 用量对拍（真实 API）', () => {
  it('anthropic 协议：同一份输入，缓存命中前后 totalInputTokens 相等', async () => {
    const capture: RawCapture = { bodies: [] };
    const candidates = await listCandidates('anthropic-messages', capture);
    expect(candidates.length, '本机未配置任何 anthropic-messages 的 AI provider，该协议未对拍').toBeGreaterThan(0);

    const outcome = await firstWorking(candidates, async (candidate) => {
      const request = {
        model: candidate.ref,
        messages: [
          { role: 'system', content: [{ kind: 'text', text: STABLE_PREFIX }] },
          { role: 'user', content: [{ kind: 'text', text: '只回复 ok' }] },
        ],
        generation: { maxOutputTokens: 16 },
      } as AiRequest;
      return [await runOnce(candidate.ai, request), await runOnce(candidate.ai, request)] as const;
    });
    expect('candidate' in outcome, `anthropic 候选全部失败：\n  ${('failures' in outcome ? outcome.failures : []).join('\n  ')}`).toBe(true);

    const { candidate, value: [first, second] } = outcome as { candidate: Candidate; value: readonly [AiUsage, AiUsage] };
    report(candidate.label, [first, second], capture);

    // 判据不依赖我对 Anthropic 文档的理解：输入内容一字未改，模型处理的输入量就
    // 不该变。变的只是其中多少走了缓存。若 3.2.4 把 cache-excluded 写反，
    // 第二轮会塌成未命中的那个零头，暴露缓存 token 被重复扣减的问题。
    expect(second.totalInputTokens).toBe(first.totalInputTokens);

    // 缓存没命中的话上面那条是空过的——两轮都没缓存时它恒成立，证伪不了任何东西。
    // 这时红灯的含义是「这次对拍没做到它该做的事」，不是「代码错了」。
    expect(
      second.cachedInputTokens ?? 0,
      '该 provider 未命中 prompt cache，cache-excluded 语义未被覆盖；换一个支持缓存的 anthropic provider 再跑',
    ).toBeGreaterThan(0);
    expect(second.totalInputTokens).toBeGreaterThan(second.cachedInputTokens!);
  }, 300_000);

  it('openai 协议：totalInput + totalOutput 等于 provider 自报的 total_tokens', async () => {
    const capture: RawCapture = { bodies: [] };
    const candidates = await listCandidates('openai', capture);
    expect(candidates.length, '本机未配置任何 openai 的 AI provider，该协议未对拍').toBeGreaterThan(0);

    const outcome = await firstWorking(candidates, (candidate) => runOnce(candidate.ai, {
      model: candidate.ref,
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'say hi' }] }],
      generation: { maxOutputTokens: 16 },
    } as AiRequest));
    expect('candidate' in outcome, `openai 候选全部失败：\n  ${('failures' in outcome ? outcome.failures : []).join('\n  ')}`).toBe(true);

    const { candidate, value: usage } = outcome as { candidate: Candidate; value: AiUsage };
    report(candidate.label, [usage], capture);

    // provider 自己算的总数，与我怎么读文档无关。若把 cached_tokens 二次相加，
    // 左边会超出右边，超出量恰好等于缓存量。
    const reported = capture.bodies.join('\n').match(/"total_tokens":\s*(\d+)/g);
    expect(reported, '未从响应体中抓到 total_tokens').toBeTruthy();
    const totalTokens = Number(reported!.at(-1)!.match(/(\d+)/)![1]);

    expect((usage.totalInputTokens ?? 0) + (usage.totalOutputTokens ?? 0)).toBe(totalTokens);

    // 缓存明细不得计入求和：它已含在 totalInputTokens 里
    if (usage.cachedInputTokens) {
      expect(usage.totalInputTokens).toBeGreaterThan(usage.cachedInputTokens);
    }
  }, 300_000);
});
