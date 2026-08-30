import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ConfigPlanIdentity } from '../../../../shared/types/config.js';
import type { ConfigDomainAdapter } from '../../contracts/domain.js';
import { ConfigDomainRegistry } from '../../core/registry.js';
import { ConfigHost, ConfigHostError } from '../config-host.js';

interface FakeDomain {
  adapter: ConfigDomainAdapter;
  createPlan: ReturnType<typeof vi.fn>;
  locate: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
}

function fakeDomain(
  id: string,
  plans: Map<string, ConfigPlanIdentity> = new Map(),
  capabilities: ConfigDomainAdapter['contract']['capabilities'] = [
    'show',
    'plan',
    'validate',
    'probe',
    'apply',
    'verify',
    'history',
    'rollback',
  ],
): FakeDomain {
  const schema = z.object({
    revision: z.number().int().describe('Monotonic revision.'),
    value: z.string().describe('Example value.'),
  });
  const locate = vi.fn(async (planId: string) => plans.get(planId));
  const validate = vi.fn(async (planId: string) => ({ planId, domain: id, valid: true }));
  const createPlan = vi.fn(async () => {
    const plan = { id: `${id}-plan`, domain: id, baseRevision: 0 };
    plans.set(plan.id, plan);
    return plan;
  });
  const adapter: ConfigDomainAdapter = {
    contract: {
      id,
      title: id,
      description: `${id} configuration.`,
      schemaVersion: 1,
      readSchema: schema,
      writeSchema: schema.omit({ revision: true }),
      capabilities,
    },
    show: async () => ({ revision: 0, value: id }),
    history: async () => [0],
    createPlan,
    locatePlan: locate,
    validate,
    probe: async (planId, input) => ({ planId, input }),
    apply: async (_planId, expectedRevision) => ({
      domain: id,
      previousRevision: expectedRevision,
      revision: expectedRevision + 1,
    }),
    verify: async (expectedRevision) => ({ healthy: true, expectedRevision }),
    rollback: async () => ({ domain: id, previousRevision: 1, revision: 2 }),
  };
  return { adapter, createPlan, locate, validate };
}

function hostOf(...domains: ConfigDomainAdapter[]): ConfigHost {
  const registry = new ConfigDomainRegistry();
  domains.forEach((domain) => registry.register(domain));
  return new ConfigHost(registry);
}

describe('ConfigHost', () => {
  it('projects typed application input through the registered write contract', () => {
    const host = hostOf(fakeDomain('example').adapter);

    expect(host.projectWrite('example', {
      revision: 9,
      value: 'next',
      runtimeObservation: true,
    })).toEqual({ value: 'next' });
  });

  it('routes a persisted Plan to the owning Domain across Host instances', async () => {
    const alphaPlans = new Map<string, ConfigPlanIdentity>();
    const betaPlans = new Map<string, ConfigPlanIdentity>();
    const firstBeta = fakeDomain('beta', betaPlans);
    const first = hostOf(fakeDomain('alpha', alphaPlans).adapter, firstBeta.adapter);
    const descriptor = first.describe('beta');
    const valueField = descriptor.fields.find((field) => field.pathTemplate === '/value')!;
    const plan = await first.createPlan('beta', {
      descriptorHash: descriptor.descriptorHash,
      changes: [{ op: 'set', fieldId: valueField.fieldId, value: 'next' }],
    });
    expect(firstBeta.createPlan).toHaveBeenCalledWith([
      { op: 'add', path: '/value', value: 'next' },
    ]);

    const secondAlpha = fakeDomain('alpha', alphaPlans);
    const secondBeta = fakeDomain('beta', betaPlans);
    const second = hostOf(secondAlpha.adapter, secondBeta.adapter);
    await expect(second.validate(plan.id)).resolves.toMatchObject({
      domain: 'beta',
      valid: true,
    });

    expect(secondAlpha.locate).toHaveBeenCalledWith(plan.id);
    expect(secondBeta.locate).toHaveBeenCalledWith(plan.id);
    expect(secondAlpha.validate).not.toHaveBeenCalled();
    expect(secondBeta.validate).toHaveBeenCalledWith(plan.id);
  });

  it('rejects undeclared capabilities with a stable protocol error', async () => {
    const domain = fakeDomain('read-only', new Map(), ['show']);
    const host = hostOf(domain.adapter);

    await expect(host.history('read-only')).rejects.toMatchObject<Partial<ConfigHostError>>({
      code: 'CONFIG_CAPABILITY_UNSUPPORTED',
      details: { domain: 'read-only', capability: 'history' },
    });
  });

  it('emits Apply and Rollback once and isolates subscriber failures', async () => {
    const domain = fakeDomain('example');
    const host = hostOf(domain.adapter);
    const plan = await host.createPatchPlan('example', []);
    const events: Array<{ revision: number; source: string }> = [];
    host.subscribe(() => {
      throw new Error('listener failed');
    });
    host.subscribe((change) => events.push(change));

    await expect(host.apply(plan.id, 0)).resolves.toMatchObject({ revision: 1 });
    expect(host.publishExternalRevision('example', 1)).toBe(false);
    expect(host.publishExternalRevision('example', 0)).toBe(false);
    await expect(host.rollback('example', 0)).resolves.toMatchObject({ revision: 2 });

    expect(events).toEqual([
      expect.objectContaining({ revision: 1, source: 'apply' }),
      expect.objectContaining({ revision: 2, source: 'rollback' }),
    ]);
  });

  it('publishes a same-revision event when the effective Descriptor changes', () => {
    const domain = fakeDomain('example');
    const host = hostOf(domain.adapter);
    const events: string[] = [];
    host.subscribe((change) => events.push(change.descriptorHash));

    expect(host.publishExternalRevision('example', 5)).toBe(true);
    domain.adapter.contract.description = 'Changed configuration contract.';
    expect(host.publishExternalRevision('example', 5)).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).not.toBe(events[1]);
  });

  it('isolates activation failures while keeping the failed Domain configurable', async () => {
    const failed = fakeDomain('failed');
    const healthy = fakeDomain('healthy');
    failed.adapter.prepare = vi.fn(async () => undefined);
    failed.adapter.activate = vi.fn(async () => {
      throw Object.assign(new Error('runtime rejected config'), {
        code: 'RUNTIME_CONFIG_REJECTED',
        details: { reason: 'test' },
      });
    });
    healthy.adapter.prepare = vi.fn(async () => undefined);
    healthy.adapter.activate = vi.fn(async () => undefined);
    const host = hostOf(failed.adapter, healthy.adapter);

    await expect(host.initialize()).resolves.toMatchObject({
      allConfigurable: true,
      allRuntimeActive: false,
    });
    expect(host.domains()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'failed',
        availability: {
          state: 'degraded',
          configurable: true,
          runtimeActive: false,
          issue: expect.objectContaining({
            stage: 'activate',
            code: 'RUNTIME_CONFIG_REJECTED',
          }),
        },
      }),
      expect.objectContaining({
        id: 'healthy',
        availability: {
          state: 'active',
          configurable: true,
          runtimeActive: true,
        },
      }),
    ]));
    await expect(host.show('failed')).resolves.toMatchObject({ value: 'failed' });
    await expect(host.history('failed')).resolves.toEqual([0]);
    await expect(host.createPatchPlan('failed', [])).resolves.toMatchObject({ domain: 'failed' });
  });

  it('retries degraded Domains after a successful Apply fixes a dependency', async () => {
    let dependencyFixed = false;
    const fixer = fakeDomain('alpha-fixer');
    const dependent = fakeDomain('beta-dependent');
    fixer.adapter.activate = vi.fn(async () => undefined);
    fixer.adapter.apply = vi.fn(async (_planId, expectedRevision) => {
      dependencyFixed = true;
      return {
        domain: 'alpha-fixer',
        previousRevision: expectedRevision,
        revision: expectedRevision + 1,
      };
    });
    dependent.adapter.activate = vi.fn(async () => {
      if (!dependencyFixed) {
        throw Object.assign(new Error('dependency is not ready'), {
          code: 'DEPENDENCY_NOT_READY',
        });
      }
    });
    const host = hostOf(fixer.adapter, dependent.adapter);

    await host.initialize();
    expect(host.domains().find((domain) => domain.id === 'beta-dependent')?.availability.state)
      .toBe('degraded');

    const plan = await host.createPatchPlan('alpha-fixer', []);
    await expect(host.apply(plan.id, 0)).resolves.toMatchObject({ revision: 1 });

    expect(dependent.adapter.activate).toHaveBeenCalledTimes(2);
    expect(host.domains().find((domain) => domain.id === 'beta-dependent')?.availability)
      .toEqual({ state: 'active', configurable: true, runtimeActive: true });
  });

  it('marks only a preparation failure unavailable and retries it lazily', async () => {
    const broken = fakeDomain('broken');
    const healthy = fakeDomain('healthy');
    const failure = Object.assign(new Error('invalid canonical document'), {
      code: 'CONFIG_INVALID',
    });
    broken.adapter.prepare = vi.fn(async () => { throw failure; });
    healthy.adapter.prepare = vi.fn(async () => undefined);
    healthy.adapter.activate = vi.fn(async () => undefined);
    const host = hostOf(broken.adapter, healthy.adapter);

    await expect(host.initialize()).resolves.toMatchObject({ allConfigurable: false });
    expect(host.domains().find((domain) => domain.id === 'broken')?.availability)
      .toMatchObject({
        state: 'unavailable',
        configurable: false,
        runtimeActive: false,
        issue: { stage: 'prepare', code: 'CONFIG_INVALID' },
      });
    await expect(host.show('healthy')).resolves.toMatchObject({ value: 'healthy' });
    await expect(host.show('broken')).rejects.toBe(failure);
    expect(broken.adapter.prepare).toHaveBeenCalledTimes(2);
  });
});
