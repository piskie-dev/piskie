import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InferenceConfig } from '../control/config-schema.js';
import type { ModelTarget } from '../execution/contracts.js';
import { createLiveRuntime, parseLiveTargets } from './runtime.js';

const live = process.env.PISKIE_LIVE_AI === '1';

describe.skipIf(!live)('live AI inference', () => {
  it('calls every configured OpenAI endpoint without changing its exact target', async () => {
    const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-live-ai-'));
    const host = createLiveRuntime({ runtimeDirectory });
    try {
      await host.initialize();
      const config = await host.repository.read();
      const selections = await host.selections.read();
      const targets = process.env.PISKIE_LIVE_AI_TARGETS
        ? parseLiveTargets(process.env.PISKIE_LIVE_AI_TARGETS, 'PISKIE_LIVE_AI_TARGETS')
        : defaultOpenAiTargets(config, selections.ai);
      expect(targets.length, 'No enabled OpenAI targets are configured').toBeGreaterThan(0);

      for (const [index, target] of targets.entries()) {
        const startedAt = Date.now();
        const runId = `live-ai-${index}-${startedAt}`;
        const result = await host.aiGateway.complete({
          model: target,
          messages: [{
            role: 'user',
            content: [{ kind: 'text', text: 'Reply with a short confirmation that this live inference request succeeded.' }],
          }],
          generation: { maxOutputTokens: 64 },
        }, {
          runId,
          traceId: `live:ai:${runId}`,
          signal: AbortSignal.timeout(180_000),
        });

        expect(result.model).toEqual(target);
        expect(result.configRevision).toBe(config.revision);
        expect(result.text.trim().length + result.reasoning.trim().length).toBeGreaterThan(0);
        console.info(JSON.stringify({
          gateway: 'ai',
          target,
          configRevision: result.configRevision,
          stopReason: result.stopReason,
          usage: result.usage,
          elapsedMs: Date.now() - startedAt,
        }));
      }
    } finally {
      await host.close();
      await fs.rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 600_000);
});

function defaultOpenAiTargets(config: InferenceConfig, selected?: ModelTarget): ModelTarget[] {
  const result = new Map<string, ModelTarget>();
  if (selected && config.providers[selected.providerId]?.driver === 'openai') {
    result.set(`${selected.providerId}\0${selected.modelId}`, selected);
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider.enabled || provider.driver !== 'openai') continue;
    const modelId = Object.entries(provider.models)
      .find(([, binding]) => binding.enabled)?.[0];
    if (!modelId) continue;
    const target = { providerId, modelId };
    result.set(`${providerId}\0${modelId}`, target);
  }
  return [...result.values()];
}
