import type {
  ConfigApplyReceipt,
  ConfigPatchOperation,
  ConfigPlan,
} from '../../../shared/types/config.js';
import type { ConfigHost } from './config-host.js';

export interface ConfigMutationResult<T> {
  receipt: ConfigApplyReceipt;
  current: T;
  plan: ConfigPlan | unknown;
}

const mutationQueues = new WeakMap<ConfigHost, Map<string, Promise<void>>>();

export async function applyConfigPatch<T = unknown>(
  host: ConfigHost,
  domain: string,
  patch: readonly ConfigPatchOperation[],
  expectedRevision?: number,
): Promise<ConfigMutationResult<T>> {
  return withMutationLock(host, domain, () => applyConfigPatchUnlocked(
    host,
    domain,
    patch,
    expectedRevision,
  ));
}

export async function mutateConfig<T = unknown>(
  host: ConfigHost,
  domain: string,
  buildPatch: (current: Readonly<T & { revision: number }>) => readonly ConfigPatchOperation[],
): Promise<ConfigMutationResult<T> | null> {
  return withMutationLock(host, domain, async () => {
    const current = await host.show<T & { revision: number }>(domain);
    const patch = buildPatch(current);
    if (patch.length === 0) return null;
    return applyConfigPatchUnlocked(host, domain, patch, current.revision);
  });
}

async function applyConfigPatchUnlocked<T = unknown>(
  host: ConfigHost,
  domain: string,
  patch: readonly ConfigPatchOperation[],
  expectedRevision?: number,
): Promise<ConfigMutationResult<T>> {
  const current = await host.show<{ revision: number }>(domain);
  const revision = expectedRevision ?? current.revision;
  if (current.revision !== revision) {
    throw new Error(
      `Expected ${domain} revision ${revision}, found ${current.revision}`,
    );
  }
  const plan = await host.createPatchPlan(domain, patch);
  const validated = await host.validate(plan.id);
  const receipt = await host.apply(plan.id, revision);
  return {
    receipt,
    current: await host.show<T>(domain),
    plan: validated,
  };
}

async function withMutationLock<T>(
  host: ConfigHost,
  domain: string,
  operation: () => Promise<T>,
): Promise<T> {
  let domains = mutationQueues.get(host);
  if (!domains) {
    domains = new Map();
    mutationQueues.set(host, domains);
  }
  const previous = domains.get(domain) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  domains.set(domain, settled);
  try {
    return await result;
  } finally {
    if (domains.get(domain) === settled) domains.delete(domain);
  }
}

export function escapeConfigPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function patchConfigFields(
  basePath: string,
  current: Readonly<Record<string, unknown>>,
  updates: Readonly<Record<string, unknown>>,
  writableFields: ReadonlySet<string>,
): ConfigPatchOperation[] {
  const patch: ConfigPatchOperation[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!writableFields.has(key)) continue;
    const path = `${basePath}/${escapeConfigPointer(key)}`;
    if (value === undefined) {
      if (Object.hasOwn(current, key)) patch.push({ op: 'remove', path });
    } else {
      patch.push({
        op: Object.hasOwn(current, key) ? 'replace' : 'add',
        path,
        value,
      });
    }
  }
  return patch;
}
