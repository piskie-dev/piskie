import { z } from 'zod';
import { DEFAULT_SETTINGS } from '../../../shared/constants/index.js';
import {
  APP_BG_MASK_MAX,
  APP_BG_MASK_MIN,
  isThemeBackgroundUrl,
} from '../../../shared/constants/theme-background.js';
import type { AppSettings } from '../../../shared/types/index.js';
import type { ConfigDomainIntegrations } from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const themeSchema = z.enum(['light', 'dark', 'auto'])
  .describe('Application color theme; auto follows the operating-system preference.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'Renderer theme updates immediately.' } });

const languageSchema = z.enum(['zh-CN', 'en-US'])
  .describe('Application interface language.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'Visible interface text is refreshed.' } });

const navEdgeDockEnabledSchema = z.boolean()
  .describe('Whether the invisible edge navigation dock is enabled.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'Edge navigation visibility updates immediately.' } });

const navPrismEnabledSchema = z.boolean()
  .describe('Whether the draggable prism navigation is enabled.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'Prism navigation visibility updates immediately.' } });

const navPrismSpotSchema = z.strictObject({
  x: z.number().describe('Horizontal viewport coordinate.'),
  y: z.number().describe('Vertical viewport coordinate.'),
}).nullable()
  .describe('Last prism navigation viewport position; null uses the default position.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'The prism moves to the configured position.' } });

const backgroundImageSchema = z.string()
  .refine(isThemeBackgroundUrl, 'Background image must be a managed theme-background URL.')
  .nullable()
  .describe('Managed application background image URL; null uses the ambient background.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'The application background updates immediately.' } });

const backgroundMaskOpacitySchema = z.number().min(APP_BG_MASK_MIN).max(APP_BG_MASK_MAX)
  .describe('Background readability mask opacity.')
  .meta({ 'x-piskie': { applyMode: 'immediate', changeImpact: 'The background mask updates immediately.' } });

export const appSettingsWriteSchema = z.strictObject({
  theme: themeSchema,
  language: languageSchema,
  navEdgeDockEnabled: navEdgeDockEnabledSchema,
  navPrismEnabled: navPrismEnabledSchema,
  navPrismSpot: navPrismSpotSchema,
  backgroundImage: backgroundImageSchema,
  backgroundMaskOpacity: backgroundMaskOpacitySchema,
});

export const appSettingsReadSchema = z.strictObject({
  revision: z.number().int().nonnegative().describe('Monotonic app-settings revision.'),
  theme: themeSchema,
  language: languageSchema,
  navEdgeDockEnabled: navEdgeDockEnabledSchema.default(DEFAULT_SETTINGS.navEdgeDockEnabled),
  navPrismEnabled: navPrismEnabledSchema.default(DEFAULT_SETTINGS.navPrismEnabled),
  navPrismSpot: navPrismSpotSchema.default(DEFAULT_SETTINGS.navPrismSpot),
  backgroundImage: backgroundImageSchema.default(DEFAULT_SETTINGS.backgroundImage),
  backgroundMaskOpacity: backgroundMaskOpacitySchema.default(DEFAULT_SETTINGS.backgroundMaskOpacity),
});

const appSettingsPersistedSchema = appSettingsReadSchema.refine(
  (settings) => settings.navEdgeDockEnabled || settings.navPrismEnabled,
  {
    path: ['navEdgeDockEnabled'],
    message: 'At least one navigation surface must remain enabled.',
  },
);

type AppSettingsWrite = z.infer<typeof appSettingsWriteSchema>;
type AppSettingsRead = z.infer<typeof appSettingsReadSchema>;
type AppSettingsDocument = AppSettingsRead;

export function createAppSettingsDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['appSettings'],
) {
  return createManagedDomain<AppSettingsDocument, AppSettingsRead, AppSettingsWrite>(rootDirectory, {
    contract: {
      id: 'app-settings',
      title: 'Application settings',
      description: 'User-visible theme, language, navigation and background preferences.',
      schemaVersion: 2,
      readSchema: appSettingsReadSchema,
      writeSchema: appSettingsWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: (raw) => appSettingsPersistedSchema.parse(raw) },
    bootstrap: () => ({
      revision: 0,
      ...structuredClone(DEFAULT_SETTINGS),
      language: integration.resolveInitialLanguage(),
    }),
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => ({ ...patched, revision: current.revision }),
      validateSemantic: (candidate) => {
        const issues = candidate.navEdgeDockEnabled || candidate.navPrismEnabled
          ? []
          : [{
              stage: 'semantic' as const,
              code: 'APP_SETTINGS_NAVIGATION_REQUIRED',
              path: '/navEdgeDockEnabled',
              message: 'At least one navigation surface must remain enabled.',
            }];
        return { valid: issues.length === 0, issues };
      },
      publish: (candidate, context) => integration.publish(toAppSettings(candidate), context),
    },
  });
}

function toAppSettings(document: AppSettingsDocument): AppSettings {
  return {
    theme: document.theme,
    language: document.language,
    navEdgeDockEnabled: document.navEdgeDockEnabled,
    navPrismEnabled: document.navPrismEnabled,
    navPrismSpot: document.navPrismSpot,
    backgroundImage: document.backgroundImage,
    backgroundMaskOpacity: document.backgroundMaskOpacity,
  };
}
