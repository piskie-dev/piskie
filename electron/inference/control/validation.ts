import type { z } from 'zod';
import type { CatalogSnapshot } from '../catalog/contracts.js';
import { resolveBoundModelDefinition } from '../catalog/query.js';
import { isReasoningSelectionAllowed } from '../ai/reasoning-policy.js';
import type { DriverRegistry } from '../drivers/registry.js';
import { inferenceConfigSchema, type InferenceConfig } from './config-schema.js';

export type ValidationStage = 'schema' | 'semantic';

export interface ValidationIssue {
  stage: ValidationStage;
  code: string;
  path: string;
  message: string;
  severity?: 'error' | 'warning';
}

export interface ValidationReport {
  valid: boolean;
  issues: readonly ValidationIssue[];
}

export interface ParsedConfigResult {
  config?: InferenceConfig;
  report: ValidationReport;
}

export interface InferenceSemanticAnalysis {
  report: ValidationReport;
  unavailableProviders: ReadonlySet<string>;
  unavailableModels: ReadonlyMap<string, ReadonlySet<string>>;
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseInferenceConfig(raw: unknown): ParsedConfigResult {
  const parsed = inferenceConfigSchema.safeParse(raw);
  if (parsed.success) return { config: parsed.data, report: { valid: true, issues: [] } };

  const issues = parsed.error.issues.flatMap((issue): ValidationIssue[] => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        stage: 'schema',
        code: 'CONFIG_UNKNOWN_FIELD',
        path: jsonPointer([...issue.path, key]),
        message: `Unknown configuration field: ${key}`,
      }));
    }
    return [{
      stage: 'schema',
      code: schemaIssueCode(issue),
      path: jsonPointer(issue.path),
      message: issue.message,
    }];
  });
  return { report: { valid: false, issues } };
}

export function validateInferenceSemantics(
  config: InferenceConfig,
  catalog: CatalogSnapshot,
  drivers: DriverRegistry,
): ValidationReport {
  return analyzeInferenceSemantics(config, catalog, drivers).report;
}

/**
 * Builds the item-level availability projection used by validation and runtime compilation.
 * A bad Provider or model is diagnostic data, not a reason to discard unrelated targets.
 */
export function analyzeInferenceSemantics(
  config: InferenceConfig,
  catalog: CatalogSnapshot,
  drivers: DriverRegistry,
): InferenceSemanticAnalysis {
  const issues: ValidationIssue[] = [];
  const unavailableProviders = new Set<string>();
  const unavailableModels = new Map<string, Set<string>>();

  const rejectProvider = (providerId: string, issue: ValidationIssue): void => {
    unavailableProviders.add(providerId);
    issues.push({ ...issue, severity: 'warning' });
  };
  const rejectModel = (providerId: string, modelId: string, issue: ValidationIssue): void => {
    const rejected = unavailableModels.get(providerId) ?? new Set<string>();
    rejected.add(modelId);
    unavailableModels.set(providerId, rejected);
    issues.push({ ...issue, severity: 'warning' });
  };

  for (const [providerId, provider] of Object.entries(config.providers)) {
    const providerPath = `/providers/${escapePointer(providerId)}`;
    if (!PROVIDER_ID.test(providerId)) {
      rejectProvider(
        providerId,
        semanticIssue('PROVIDER_ID_INVALID', providerPath, `Invalid provider ID: ${providerId}`),
      );
    }

    const driver = drivers.get(provider.driver);
    if (!driver) {
      rejectProvider(
        providerId,
        semanticIssue('DRIVER_NOT_FOUND', `${providerPath}/driver`, `Driver is not registered: ${provider.driver}`),
      );
      continue;
    }
    if (!driver.manifest.acceptedAuth.includes(provider.connection.auth.kind)) {
      rejectProvider(providerId, semanticIssue(
        'DRIVER_AUTH_UNSUPPORTED',
        `${providerPath}/connection/auth`,
        `Driver ${provider.driver} does not accept auth kind ${provider.connection.auth.kind}`,
      ));
    }
    try {
      for (const issue of driver.validateProviderOptions(provider.driverOptions)) {
        rejectProvider(
          providerId,
          semanticIssue(issue.code, `${providerPath}/driverOptions${issue.path}`, issue.message),
        );
      }
    } catch (cause) {
      rejectProvider(providerId, semanticIssue(
        'DRIVER_PROVIDER_VALIDATION_FAILED',
        `${providerPath}/driverOptions`,
        `Driver ${provider.driver} could not validate Provider options: ${errorMessage(cause)}`,
      ));
    }

    for (const [modelId, binding] of Object.entries(provider.models)) {
      const modelPath = `${providerPath}/models/${escapePointer(modelId)}`;
      if (modelId.trim() !== modelId || !isValidModelId(modelId)) {
        rejectModel(
          providerId,
          modelId,
          semanticIssue('MODEL_ID_INVALID', modelPath, `Invalid model ID: ${modelId}`),
        );
      }

      const definition = resolveBoundModelDefinition(catalog, {
        catalogId: binding.catalogId,
        upstreamId: binding.upstreamId,
        driverId: provider.driver,
      });
      if (!definition) {
        rejectModel(providerId, modelId, semanticIssue(
          'CATALOG_MODEL_NOT_FOUND',
          `${modelPath}/catalogId`,
          `Catalog model does not exist: ${binding.catalogId}`,
        ));
      } else {
        if (definition.kind === 'ai' && definition.limits.contextWindow === undefined) {
          rejectModel(providerId, modelId, semanticIssue(
            'MODEL_CONTEXT_WINDOW_MISSING',
            `${modelPath}/catalogId`,
            `AI catalog model ${binding.catalogId} must explicitly configure limits.contextWindow`,
          ));
        }
        if (!definition.compatibleDrivers.includes(provider.driver)) {
          rejectModel(providerId, modelId, semanticIssue(
            'MODEL_DRIVER_INCOMPATIBLE',
            `${modelPath}/catalogId`,
            `Catalog model ${binding.catalogId} is not compatible with driver ${provider.driver}`,
          ));
        }
        if (binding.defaultReasoning
          && !isReasoningSelectionAllowed(binding.defaultReasoning, definition.reasoning)) {
          rejectModel(providerId, modelId, semanticIssue(
            'MODEL_REASONING_DEFAULT_INVALID',
            `${modelPath}/defaultReasoning`,
            `The configured reasoning default is not supported by catalog model ${binding.catalogId}`,
          ));
        }
        const requiredGateway = definition.kind;
        if (!driver.manifest.supportedGateways.includes(requiredGateway)) {
          rejectModel(providerId, modelId, semanticIssue(
            'DRIVER_GATEWAY_INCOMPATIBLE',
            `${modelPath}/catalogId`,
            `Driver ${provider.driver} cannot compile ${requiredGateway} targets`,
          ));
        }
      }

      try {
        for (const issue of driver.validateModelOptions(binding.options)) {
          rejectModel(
            providerId,
            modelId,
            semanticIssue(issue.code, `${modelPath}/options${issue.path}`, issue.message),
          );
        }
      } catch (cause) {
        rejectModel(providerId, modelId, semanticIssue(
          'DRIVER_MODEL_VALIDATION_FAILED',
          `${modelPath}/options`,
          `Driver ${provider.driver} could not validate model options: ${errorMessage(cause)}`,
        ));
      }
    }
  }

  return {
    report: { valid: true, issues },
    unavailableProviders,
    unavailableModels,
  };
}

function isValidModelId(value: string): boolean {
  return value.length > 0 && [...value].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint > 0x1f && codePoint !== 0x7f;
  });
}

function schemaIssueCode(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return 'CONFIG_INVALID_TYPE';
    case 'invalid_value':
      return 'CONFIG_INVALID_VALUE';
    case 'too_small':
    case 'too_big':
      return 'CONFIG_OUT_OF_RANGE';
    case 'unrecognized_keys':
      return 'CONFIG_UNKNOWN_FIELD';
    default:
      return 'CONFIG_SCHEMA_INVALID';
  }
}

function semanticIssue(code: string, path: string, message: string): ValidationIssue {
  return { stage: 'semantic', code, path, message };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function jsonPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  return `/${path.map((part) => escapePointer(String(part))).join('/')}`;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
