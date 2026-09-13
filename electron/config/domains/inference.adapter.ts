import type {
  ConfigChangeImpact,
  ConfigDynamicExtensionDescriptor,
  ConfigValidationIssue,
} from '../../../shared/types/config.js';
import {
  inferenceConfigSchema,
  inferenceConfigWriteSchema,
  type InferenceConfig,
} from '../../inference/control/config-schema.js';
import { emptyInferenceConfig } from '../../inference/control/bootstrap-config.js';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type { ConfigProbeInput } from '../contracts/domain.js';
import { ManagedConfigDomain } from '../core/managed-config-domain.js';
import type { ConfigDomainReader } from './integrations.js';

type InferenceWrite = Omit<InferenceConfig, 'schemaVersion' | 'revision'>;

const CAPABILITIES = [
  'show',
  'plan',
  'validate',
  'probe',
  'apply',
  'verify',
  'history',
  'rollback',
] as const;

export function createInferenceDomain(
  control: InferenceControlPlane,
  readDomain?: ConfigDomainReader,
): ManagedConfigDomain<InferenceConfig, InferenceConfig, InferenceWrite> {
  const contract = {
    id: 'inference',
    title: 'AI and image inference',
    description: 'Provider instances, model bindings, Driver options, and AI/Image Gateway policies.',
    schemaVersion: 1,
    readSchema: inferenceConfigSchema,
    writeSchema: inferenceConfigWriteSchema,
    capabilities: CAPABILITIES,
    extensions: () => driverExtensions(control),
  };

  return new ManagedConfigDomain({
    contract,
    repository: control.configRepository,
    bootstrap: emptyInferenceConfig,
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => ({
        schemaVersion: 1,
        revision: current.revision,
        ...patched,
      }),
      dependencyRevisions: readDomain
        ? async () => dependencyRevisions(readDomain)
        : undefined,
      validateSemantic: async (candidate) => {
        const inference = await control.validateConfigCandidate(candidate);
        const references = readDomain
          ? await validateReferences(candidate, readDomain)
          : [];
        return {
          valid: inference.valid && references.length === 0,
          issues: [...inference.issues, ...references],
        };
      },
      analyzeImpact: readDomain
        ? (current, candidate) => analyzeReferenceImpact(current, candidate, readDomain)
        : undefined,
      probe: (candidate, input) => probeCandidate(control, candidate, input),
      publish: (candidate) => control.publishConfigCandidate(candidate),
      verify: (_candidate, expectedRevision) => control.verify(expectedRevision),
    },
  }, control.configRepository.paths.plansDirectory);
}

async function dependencyRevisions(
  readDomain: ConfigDomainReader,
): Promise<Readonly<Record<string, number>>> {
  const domainIds = ['inference-selections', 'model-catalog', 'proxies'] as const;
  const documents = await Promise.all(domainIds.map((domain) => readDomain(domain)));
  return Object.fromEntries(domainIds.map((domain, index) => [
    domain,
    revisionOf(documents[index]),
  ]));
}

async function validateReferences(
  candidate: InferenceConfig,
  readDomain: ConfigDomainReader,
): Promise<ConfigValidationIssue[]> {
  const [proxies, selections] = await Promise.all([
    readDomain('proxies'),
    readDomain('inference-selections'),
  ]);
  const issues: ConfigValidationIssue[] = [];

  for (const [providerId, provider] of Object.entries(candidate.providers)) {
    const proxyId = provider.connection.proxyId;
    if (proxyId && !hasRecordEntry(proxies, 'proxies', proxyId)) {
      issues.push({
        stage: 'reference',
        code: 'INFERENCE_PROXY_NOT_FOUND',
        path: `/providers/${escapePointer(providerId)}/connection/proxyId`,
        message: `Inference Provider ${providerId} references missing proxy ${proxyId}.`,
      });
    }
  }

  for (const gateway of ['ai', 'image'] as const) {
    const target = recordTarget(selections, gateway);
    if (target && !hasTarget(candidate, target.providerId, target.modelId)) {
      issues.push({
        stage: 'reference',
        code: 'INFERENCE_SELECTION_STILL_REFERENCED',
        path: `/providers/${escapePointer(target.providerId)}/models/${escapePointer(target.modelId)}`,
        message: `${gateway} selection still references ${target.providerId}/${target.modelId}.`,
      });
    }
  }

  return issues;
}

async function analyzeReferenceImpact(
  current: InferenceConfig,
  candidate: InferenceConfig,
  readDomain: ConfigDomainReader,
): Promise<ConfigChangeImpact[]> {
  const removed = removedTargets(current, candidate);
  if (removed.size === 0) return [];
  const selections = await readDomain('inference-selections');
  const impacts: ConfigChangeImpact[] = [];

  for (const gateway of ['ai', 'image'] as const) {
    const target = recordTarget(selections, gateway);
    if (!target || !removed.has(removedTargetKey(target.providerId, target.modelId))) continue;
    impacts.push({
      code: 'INFERENCE_SELECTION_TARGET_REMOVED',
      severity: 'high',
      path: `/providers/${escapePointer(target.providerId)}/models/${escapePointer(target.modelId)}`,
      message: `${gateway} selection target ${target.providerId}/${target.modelId} will be removed.`,
    });
  }
  return impacts;
}

function probeCandidate(
  control: InferenceControlPlane,
  candidate: InferenceConfig,
  input: ConfigProbeInput,
) {
  const providerId = input.target?.providerId;
  const modelId = input.target?.modelId;
  return control.probeConfigCandidate(
    candidate,
    input.level,
    providerId || modelId ? { providerId, modelId } : undefined,
  );
}

function driverExtensions(control: InferenceControlPlane): ConfigDynamicExtensionDescriptor[] {
  return control.drivers().map((driver) => {
    const schema = control.driverSchema(driver.id);
    return {
      id: `inference-driver:${driver.id}`,
      kind: 'inference-driver',
      title: driver.id,
      selector: {
        path: '/providers/{providerId}/driver',
        value: driver.id,
      },
      schemas: [
        {
          name: 'providerOptions',
          path: '/providers/{providerId}/driverOptions',
          schema: schema.providerOptions as Record<string, unknown>,
        },
        {
          name: 'modelOptions',
          path: '/providers/{providerId}/models/{modelId}/options',
          schema: schema.modelOptions as Record<string, unknown>,
        },
      ],
    };
  });
}

function removedTargets(current: InferenceConfig, candidate: InferenceConfig): Set<string> {
  const removed = new Set<string>();
  for (const [providerId, provider] of Object.entries(current.providers)) {
    for (const modelId of Object.keys(provider.models)) {
      if (!candidate.providers[providerId]?.models[modelId]) {
        removed.add(removedTargetKey(providerId, modelId));
      }
    }
  }
  return removed;
}

function recordTarget(value: unknown, key: string): { providerId: string; modelId: string } | undefined {
  if (!isRecord(value) || !isRecord(value[key])) return undefined;
  const target = value[key];
  return typeof target.providerId === 'string' && typeof target.modelId === 'string'
    ? { providerId: target.providerId, modelId: target.modelId }
    : undefined;
}

function hasTarget(config: InferenceConfig, providerId: string, modelId: string): boolean {
  const provider = config.providers[providerId];
  return Boolean(provider?.enabled && provider.models[modelId]?.enabled);
}

function hasRecordEntry(value: unknown, collection: string, id: string): boolean {
  return isRecord(value) && isRecord(value[collection]) && Object.hasOwn(value[collection], id);
}

function removedTargetKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

function revisionOf(value: unknown): number {
  return isRecord(value) && Number.isInteger(value.revision) ? value.revision as number : 0;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
