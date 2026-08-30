import { z } from 'zod';
import type {
  BrowserEnvironmentsSnapshot,
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const timezonePolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('ip').describe('Resolve the browser timezone from the launch network route.'),
  }),
  z.strictObject({
    mode: z.literal('real').describe('Resolve the browser timezone from the real host environment.'),
  }),
  z.strictObject({
    mode: z.literal('custom').describe('Use an explicitly configured browser timezone.'),
    value: z.string().trim().min(1).describe('IANA timezone used when timezone mode is custom.'),
  }),
]);
const geolocationPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('ip').describe('Resolve browser geolocation from the launch network route.'),
  }),
  z.strictObject({
    mode: z.literal('off').describe('Disable browser geolocation for this environment.'),
  }),
  z.strictObject({
    mode: z.literal('custom').describe('Use explicitly configured browser geolocation coordinates.'),
    latitude: z.number().min(-90).max(90).describe('Latitude used when geolocation mode is custom.'),
    longitude: z.number().min(-180).max(180).describe('Longitude used when geolocation mode is custom.'),
    accuracy: z.number().positive()
      .describe('Optional geolocation accuracy radius in metres.')
      .optional(),
  }),
]);
const languagePolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('ip').describe('Resolve the browser language from the launch network route.'),
  }),
  z.strictObject({
    mode: z.literal('custom').describe('Use an explicitly configured browser language.'),
    value: z.string().trim().min(1).describe('Browser locale used when language mode is custom.'),
  }),
]);

const identityPolicySchema = z.strictObject({
  platform: z.enum(['macos', 'windows', 'linux'])
    .describe('Operating-system identity presented by the browser kernel.')
    .optional(),
  userAgent: z.string().describe('Optional custom browser User-Agent.').optional(),
  timezone: timezonePolicySchema.describe('How the browser timezone is resolved for each launch.'),
  geolocation: geolocationPolicySchema.describe('How browser geolocation is resolved or disabled.'),
  language: languagePolicySchema.describe('How browser locale is resolved for each launch.'),
  hardwareConcurrency: z.number().int().positive()
    .describe('Optional logical CPU count exposed to websites.')
    .optional(),
  extra: z.record(z.string(), z.unknown())
    .describe('Additional fingerprint options understood by the browser runtime.')
    .meta({ 'x-piskie': { keyPlaceholder: 'optionName' } })
    .optional(),
});

const environmentWriteSchema = z.strictObject({
  name: z.string().trim().min(1).describe('User-visible browser environment name.'),
  purpose: z.string().max(200).describe('When and why an Agent should use this environment.').optional(),
  groupId: z.string().trim().min(1).describe('Optional environment group ID.').optional(),
  platform: z.string().trim().min(1).describe('Optional organizational platform label.').optional(),
  identityPolicy: identityPolicySchema.describe('Browser identity policy resolved for each launch.'),
  proxyId: z.string().trim().min(1).describe('Optional global proxy ID.').optional(),
  extensionIds: z.array(z.string().trim().min(1).describe('Browser extension ID.'))
    .describe('Browser extension IDs loaded for this environment.')
    .optional(),
});

const groupWriteSchema = z.strictObject({
  name: z.string().trim().min(1).describe('User-visible browser environment group name.'),
});

const environmentStoredSchema = environmentWriteSchema.extend({
  createdAt: z.number().int().nonnegative(),
});
const groupStoredSchema = groupWriteSchema.extend({
  createdAt: z.number().int().nonnegative(),
});
const environmentReadSchema = environmentWriteSchema.extend({
  status: z.enum(['idle', 'running']).describe('Observed browser runtime status.'),
  currentBrowserId: z.string().describe('Current browser runtime ID when running.').optional(),
  restartRequired: z.boolean()
    .describe('Whether the running browser must restart to apply current environment or proxy facts.')
    .optional(),
  userDataId: z.string().describe('System-managed isolated browser data ID.').optional(),
  createdAt: z.number().int().nonnegative().describe('System-assigned creation timestamp.'),
  lastUsedAt: z.number().int().nonnegative().describe('Observed most recent use timestamp.').optional(),
});

const groupReadSchema = groupWriteSchema.extend({
  createdAt: z.number().int().nonnegative().describe('System-assigned group creation timestamp.'),
});

const records = {
  environments: { 'x-piskie': { keyPlaceholder: 'environmentId', applyMode: 'next-browser-start' } },
  groups: { 'x-piskie': { keyPlaceholder: 'groupId', applyMode: 'immediate' } },
};

export const browserEnvironmentsWriteSchema = z.strictObject({
  environments: z.record(z.string().trim().min(1), environmentWriteSchema)
    .describe('Browser environments keyed by immutable environment ID.').meta(records.environments),
  groups: z.record(z.string().trim().min(1), groupWriteSchema)
    .describe('Browser environment groups keyed by immutable group ID.').meta(records.groups),
});

export const browserEnvironmentsReadSchema = z.strictObject({
  revision: z.number().int().nonnegative().describe('Monotonic browser-profiles domain revision.'),
  environments: z.record(z.string().trim().min(1), environmentReadSchema)
    .describe('Browser environments with read-only runtime observations.').meta(records.environments),
  groups: z.record(z.string().trim().min(1), groupReadSchema)
    .describe('Browser environment groups keyed by immutable group ID.').meta(records.groups),
});

type EnvironmentStored = z.infer<typeof environmentStoredSchema>;
type GroupStored = z.infer<typeof groupStoredSchema>;
type BrowserEnvironmentsWrite = z.infer<typeof browserEnvironmentsWriteSchema>;
type BrowserEnvironmentsRead = z.infer<typeof browserEnvironmentsReadSchema>;
interface BrowserEnvironmentsDocument {
  revision: number;
  environments: Record<string, EnvironmentStored>;
  groups: Record<string, GroupStored>;
}

export function createBrowserEnvironmentsDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['browserEnvironments'],
  readDomain: ConfigDomainReader,
  now: () => number = () => Date.now(),
) {
  return createManagedDomain<BrowserEnvironmentsDocument, BrowserEnvironmentsRead, BrowserEnvironmentsWrite>(rootDirectory, {
    contract: {
      id: 'browser-profiles',
      title: 'Browser Environments',
      description: 'Persistent browser environments and groups; runtime status remains read-only.',
      schemaVersion: 3,
      readSchema: browserEnvironmentsReadSchema,
      writeSchema: browserEnvironmentsWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: (raw) => browserEnvironmentsStoredSchema.parse(raw) },
    bootstrap: () => ({ revision: 0, environments: {}, groups: {} }),
    adapter: {
      projectRead: (stored) => projectRead(stored, integration),
      normalizeCandidate: (current, patched) => {
        for (const id of Object.keys(current.environments)) {
          if (!patched.environments[id] && integration.environmentInUse?.(id)) {
            throw new Error(`Browser environment ${id} is currently running and cannot be removed.`);
          }
        }
        return normalizeCandidate(current, patched, now);
      },
      dependencyRevisions: async () => ({
        proxies: revisionOf(await readDomain('proxies')),
      }),
      validateSemantic: async (candidate) => validateReferences(
        candidate,
        await readDomain('proxies'),
      ),
      analyzeImpact: (current, candidate) => Object.keys(current.environments)
        .filter((id) => !candidate.environments[id])
        .map((id) => ({
          code: 'BROWSER_ENVIRONMENT_REMOVED',
          severity: 'high' as const,
          path: `/environments/${escapePointer(id)}`,
          message: `Browser environment ${id} and its future-use configuration will be removed.`,
        })),
      publish: (candidate, context) => integration.publish(toSnapshot(candidate), context),
    },
  });
}

export const browserEnvironmentsStoredSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  environments: z.record(z.string().trim().min(1), environmentStoredSchema),
  groups: z.record(z.string().trim().min(1), groupStoredSchema),
});

function projectRead(
  document: BrowserEnvironmentsDocument,
  integration: ConfigDomainIntegrations['browserEnvironments'],
): BrowserEnvironmentsRead {
  const base = toSnapshot(document);
  const observed = integration.observe?.(base) ?? base;
  const environments = new Map(observed.environments.map((environment) => [environment.id, environment]));
  return {
    ...document,
    revision: document.revision,
    environments: Object.fromEntries(Object.entries(document.environments).map(([id, environment]) => {
      const observation = environments.get(id);
      return [id, environmentReadSchema.parse({
        ...environment,
        status: observation?.status ?? 'idle',
        currentBrowserId: observation?.currentBrowserId,
        restartRequired: observation?.restartRequired,
        userDataId: observation?.userDataId,
        lastUsedAt: observation?.lastUsedAt,
      })];
    })),
    groups: document.groups,
  };
}

function normalizeCandidate(
  current: BrowserEnvironmentsDocument,
  patched: BrowserEnvironmentsWrite,
  now: () => number,
): BrowserEnvironmentsDocument {
  const timestamp = now();
  return {
    ...patched,
    revision: current.revision,
    environments: sortedEntries(patched.environments, (id, environment) => ({
      ...environment,
      createdAt: current.environments[id]?.createdAt ?? timestamp,
    })),
    groups: sortedEntries(patched.groups, (id, group) => ({
      ...group,
      createdAt: current.groups[id]?.createdAt ?? timestamp,
    })),
  };
}

function validateReferences(
  candidate: BrowserEnvironmentsDocument,
  proxies: unknown,
) {
  const issues: Array<{ stage: 'reference' | 'lifecycle'; code: string; path: string; message: string }> = [];
  for (const [id, environment] of Object.entries(candidate.environments)) {
    if (environment.groupId && !candidate.groups[environment.groupId]) {
      issues.push({
        stage: 'reference',
        code: 'ENVIRONMENT_GROUP_NOT_FOUND',
        path: `/environments/${escapePointer(id)}/groupId`,
        message: `Browser environment ${id} references missing group ${environment.groupId}.`,
      });
    }
    if (environment.proxyId && !globalProxyIds(proxies).has(environment.proxyId)) {
      issues.push({
        stage: 'reference',
        code: 'ENVIRONMENT_PROXY_NOT_FOUND',
        path: `/environments/${escapePointer(id)}/proxyId`,
        message: `Browser environment ${id} references missing global proxy ${environment.proxyId}.`,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}

function toSnapshot(document: BrowserEnvironmentsDocument): BrowserEnvironmentsSnapshot {
  return {
    environments: Object.entries(document.environments).map(([id, environment]) => ({
      id,
      ...environment,
      status: 'idle' as const,
    })),
    groups: Object.entries(document.groups).map(([id, group]) => ({ id, ...group })),
  };
}

function globalProxyIds(value: unknown): Set<string> {
  if (!isRecord(value) || !isRecord(value.proxies)) return new Set();
  return new Set(Object.keys(value.proxies));
}

function sortedEntries<T, R>(record: Record<string, T>, map: (id: string, value: T) => R): Record<string, R> {
  return Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, value]) => [id, map(id, value)]));
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
