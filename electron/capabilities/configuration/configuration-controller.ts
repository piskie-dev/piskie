import { z } from 'zod';
import {
  CONFIGURATION_OPERATIONS,
  CONFIGURATION_TOPICS,
} from '../../../shared/electron-contracts/configuration.js';
import type {
  ProxyCreateInput,
  ProxyUpdateInput,
} from '../../../shared/electron-contracts/configuration.js';
import type {
  AppSettings,
  ConfigPlanRequest,
  ConfigProbeRequest,
} from '../../../shared/types/index.js';
import type { OperationDefinition, TopicDefinition } from '../catalog.js';
import { args, identifier, nonNegativeInteger } from '../validation.js';
import type { ConfigurationApplication } from './configuration-application.js';
import {
  APP_BG_MASK_MAX,
  APP_BG_MASK_MIN,
  isThemeBackgroundUrl,
} from '../../../shared/constants/theme-background.js';

const fieldChange = z.object({
  op: z.enum(['set', 'remove']),
  fieldId: identifier,
  bindings: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  value: z.unknown().optional(),
});
const planRequest = z.object({
  descriptorHash: identifier,
  changes: z.array(fieldChange).max(1_000),
});
const probeRequest = z.object({
  level: z.enum(['connectivity', 'smoke']),
  target: z.record(z.string(), z.string().optional()).optional(),
});
const navPrismSpotSchema = z.strictObject({ x: z.number(), y: z.number() }).nullable();
const backgroundImageSchema = z.string().refine(isThemeBackgroundUrl).nullable();
const settingsKeySchema = z.enum([
  'theme',
  'language',
  'navEdgeDockEnabled',
  'navPrismEnabled',
  'navPrismSpot',
  'backgroundImage',
  'backgroundMaskOpacity',
]);
const settingsSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'auto']).optional(),
  language: z.enum(['zh-CN', 'en-US']).optional(),
  navEdgeDockEnabled: z.boolean().optional(),
  navPrismEnabled: z.boolean().optional(),
  navPrismSpot: navPrismSpotSchema.optional(),
  backgroundImage: backgroundImageSchema.optional(),
  backgroundMaskOpacity: z.number().min(APP_BG_MASK_MIN).max(APP_BG_MASK_MAX).optional(),
});
const settingValueSchema = z.union([
  z.enum(['light', 'dark', 'auto']),
  z.enum(['zh-CN', 'en-US']),
  z.boolean(),
  navPrismSpotSchema,
  backgroundImageSchema,
  z.number().min(APP_BG_MASK_MIN).max(APP_BG_MASK_MAX),
]);
const proxySchema = z.object({
  name: identifier,
  protocol: z.enum(['http', 'https', 'socks5']),
  host: identifier,
  port: z.number().int().min(1).max(65_535),
  username: z.string().max(4_096).optional(),
  password: z.string().max(16_384).optional(),
  enabled: z.boolean(),
});

export function createConfigurationController(
  application: ConfigurationApplication,
  subscribe: TopicDefinition['open'],
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(CONFIGURATION_OPERATIONS.listDomains, args([]), () => application.listDomains()),
    operation(CONFIGURATION_OPERATIONS.describe, args([identifier]), ([domain]) => (
      application.describe(domain)
    )),
    operation(CONFIGURATION_OPERATIONS.read, args([identifier]), ([domain]) => (
      application.read(domain)
    )),
    operation(CONFIGURATION_OPERATIONS.history, args([identifier]), ([domain]) => (
      application.history(domain)
    )),
    operation(
      CONFIGURATION_OPERATIONS.plan,
      args([identifier, planRequest]),
      ([domain, request]) => application.plan(domain, request as ConfigPlanRequest),
    ),
    operation(CONFIGURATION_OPERATIONS.validate, args([identifier]), ([planId]) => (
      application.validate(planId)
    )),
    operation(
      CONFIGURATION_OPERATIONS.probe,
      args([identifier, probeRequest]),
      ([planId, request]) => application.probe(planId, request as ConfigProbeRequest),
    ),
    operation(
      CONFIGURATION_OPERATIONS.apply,
      args([identifier, nonNegativeInteger]),
      ([planId, revision]) => application.apply(planId, revision),
    ),
    operation(
      CONFIGURATION_OPERATIONS.verify,
      args([identifier, nonNegativeInteger.optional()]),
      ([domain, revision]) => application.verify(domain, revision),
    ),
    operation(
      CONFIGURATION_OPERATIONS.rollback,
      args([identifier, nonNegativeInteger]),
      ([domain, revision]) => application.rollback(domain, revision),
    ),
    operation(CONFIGURATION_OPERATIONS.readSettings, args([]), () => application.readSettings()),
    operation(
      CONFIGURATION_OPERATIONS.readSetting,
      args([settingsKeySchema]),
      ([key]) => application.readSetting(key),
    ),
    operation(
      CONFIGURATION_OPERATIONS.writeSetting,
      args([
        settingsKeySchema,
        settingValueSchema,
      ]),
      ([key, value]) => application.writeSetting(
        key as keyof AppSettings,
        value as never,
      ),
    ),
    operation(CONFIGURATION_OPERATIONS.writeSettings, args([settingsSchema]), ([settings]) => (
      application.writeSettings(settings as Partial<AppSettings>)
    )),
    operation(CONFIGURATION_OPERATIONS.resetSettings, args([]), () => application.resetSettings()),
    operation(
      CONFIGURATION_OPERATIONS.developmentFeatures,
      args([]),
      () => application.developmentFeatures(),
    ),
    operation(CONFIGURATION_OPERATIONS.readProxy, args([]), () => application.readProxyConfig()),
    operation(CONFIGURATION_OPERATIONS.addProxy, args([proxySchema]), ([proxy]) => (
      application.addProxy(proxy as ProxyCreateInput)
    )),
    operation(
      CONFIGURATION_OPERATIONS.updateProxy,
      args([identifier, proxySchema.partial()]),
      ([id, updates]) => application.updateProxy(id, updates as ProxyUpdateInput),
    ),
    operation(CONFIGURATION_OPERATIONS.removeProxy, args([identifier]), ([id]) => (
      application.removeProxy(id)
    )),
    {
      id: CONFIGURATION_OPERATIONS.testProxy,
      capability: 'configuration',
      input: args([identifier]),
      execute: (context, input) => application.testProxy(
        (input as unknown[])[0] as string,
        context.signal,
      ),
    },
  ];
  const changesTopic: TopicDefinition = {
    id: CONFIGURATION_TOPICS.changes,
    capability: 'configuration',
    input: z.undefined(),
    open: subscribe,
  };

  return Object.freeze({
    operations: Object.freeze(operations),
    topics: Object.freeze([changesTopic]),
  });
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[]) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'configuration',
    input,
    execute: (_context, value) => execute(value),
  };
}
