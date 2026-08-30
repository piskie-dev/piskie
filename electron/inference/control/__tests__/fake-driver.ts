import type { InferenceDriver } from '../../drivers/contracts.js';

export function createFakeDriver(): InferenceDriver {
  return {
    manifest: {
      id: 'fake',
      supportedGateways: ['ai'],
      acceptedAuth: ['none', 'bearer', 'api_key'],
      providerConfigSchema: { type: 'object' },
      modelOptionsSchema: { type: 'object' },
    },
    validateProviderOptions: () => [],
    validateModelOptions: () => [],
    compile: (input) => ({
      ref: { providerId: input.providerId, modelId: input.modelId },
      driverId: 'fake',
      upstreamModel: input.binding.upstreamId,
      catalogId: input.binding.catalogId,
      configRevision: input.configRevision,
      ai: {
        openAttempt: async function* () {
          yield { kind: 'response.completed', stopReason: 'end_turn' };
        },
      },
    }),
    probeConnectivity: async (input) => ({
      driverId: 'fake',
      providerId: input.providerId,
      level: 'connectivity',
      success: true,
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:00.001Z',
    }),
  };
}
