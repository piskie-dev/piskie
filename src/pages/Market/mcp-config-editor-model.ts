import type {
  McpRegistrySearchResult,
  McpServerConfig,
} from '@shared/types/mcp';

export type McpEditorTransport = 'stdio' | 'streamable_http';

export interface McpKeyValueDraft {
  key: string;
  value: string;
}

/** 编辑器只覆盖这几项，其余字段在保存时原样保留 */
export interface McpConfigDraft {
  transport: McpEditorTransport;
  command: string;
  argsText: string;
  env: McpKeyValueDraft[];
  url: string;
  httpHeaders: McpKeyValueDraft[];
  proxyId: string;
  enabled: boolean;
}

export interface McpRegistryEnvironmentHint {
  name: string;
  description?: string;
  format?: string;
  secret: boolean;
  required: boolean;
}

export type McpConfigBuildResult =
  | { success: true; config: McpServerConfig }
  | { success: false; errors: string[] };

export interface McpConfigValidationLabels {
  commandRequired: string;
  addressRequired: string;
  addressProtocol: string;
  addressInvalid: string;
  environmentVariables: string;
  requestHeaders: string;
  missingRowName(label: string, row: number): string;
  duplicateRowName(label: string, name: string): string;
}

interface McpPackageIdentity {
  kind: 'npm' | 'pypi' | 'docker';
  identifier: string;
}

const recordRows = (record?: Record<string, string>): McpKeyValueDraft[] =>
  Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));

const lineValues = (value: string): string[] => value
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

function stripPackageVersion(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0) return trimmed;
  if (trimmed.startsWith('@') && separator < trimmed.indexOf('/')) return trimmed;
  return trimmed.slice(0, separator);
}

function commandName(command?: string): string {
  return command?.split(/[\\/]/).at(-1)?.replace(/\.(?:cmd|exe)$/i, '').toLowerCase() ?? '';
}

export function mcpConfigPackageIdentity(config: McpServerConfig): McpPackageIdentity | undefined {
  const command = commandName(config.command);
  const args = config.args ?? [];
  if (command === 'npx') {
    const identifier = args.find((argument) => !argument.startsWith('-'));
    return identifier ? { kind: 'npm', identifier: stripPackageVersion(identifier) } : undefined;
  }
  if (command === 'uvx') {
    const identifier = args.find((argument) => !argument.startsWith('-'));
    return identifier ? { kind: 'pypi', identifier: stripPackageVersion(identifier) } : undefined;
  }
  if (command === 'docker' || command === 'podman') {
    const runIndex = args.indexOf('run');
    const identifier = args.slice(runIndex >= 0 ? runIndex + 1 : 0)
      .find((argument) => !argument.startsWith('-'));
    return identifier ? { kind: 'docker', identifier: stripPackageVersion(identifier) } : undefined;
  }
  return undefined;
}

export function mcpRegistrySearchQuery(serverName: string, registryName?: string): string {
  return registryName?.trim() || serverName;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function packageIdentifier(value: unknown): string | undefined {
  const pkg = objectValue(value);
  if (!pkg) return undefined;
  const identifier = typeof pkg.identifier === 'string'
    ? pkg.identifier
    : typeof pkg.name === 'string'
      ? pkg.name
      : undefined;
  return identifier ? stripPackageVersion(identifier) : undefined;
}

function normalizedName(value: string): string {
  return decodeURIComponent(value).trim().toLowerCase();
}

function matchingResults(
  results: readonly McpRegistrySearchResult[],
  serverName: string,
  config: McpServerConfig,
): McpRegistrySearchResult[] {
  const identity = mcpConfigPackageIdentity(config);
  if (identity) {
    const packageMatches = results.filter((result) => result.packages?.some((pkg) =>
      normalizedName(packageIdentifier(pkg) ?? '') === normalizedName(identity.identifier)));
    if (packageMatches.length > 0) return packageMatches;
  }

  const nameMatches = results.filter((result) => normalizedName(result.name) === normalizedName(serverName));
  if (nameMatches.length > 0) return nameMatches;

  if (config.url) {
    const remoteMatches = results.filter((result) => result.remotes?.some((remoteValue) => {
      const remote = objectValue(remoteValue);
      return typeof remote?.url === 'string' && remote.url === config.url;
    }));
    if (remoteMatches.length > 0) return remoteMatches;
  }
  return [];
}

/** 从与当前启动包严格匹配的 Registry 记录提取环境变量，不把同名搜索结果互相冒认。 */
export function registryEnvironmentHints(
  results: readonly McpRegistrySearchResult[],
  serverName: string,
  config: McpServerConfig,
): McpRegistryEnvironmentHint[] {
  const identity = mcpConfigPackageIdentity(config);
  const hints = new Map<string, McpRegistryEnvironmentHint>();
  for (const result of matchingResults(results, serverName, config)) {
    for (const packageValue of result.packages ?? []) {
      if (identity && normalizedName(packageIdentifier(packageValue) ?? '') !== normalizedName(identity.identifier)) {
        continue;
      }
      const pkg = objectValue(packageValue);
      const variables = Array.isArray(pkg?.environmentVariables) ? pkg.environmentVariables : [];
      for (const variableValue of variables) {
        const variable = objectValue(variableValue);
        const name = typeof variable?.name === 'string' ? variable.name.trim() : '';
        if (!name) continue;
        const previous = hints.get(name);
        hints.set(name, {
          name,
          description: typeof variable?.description === 'string'
            ? variable.description
            : previous?.description,
          format: typeof variable?.format === 'string' ? variable.format : previous?.format,
          secret: variable?.isSecret === true || previous?.secret === true,
          required: variable?.isRequired === true || variable?.required === true || previous?.required === true,
        });
      }
    }
  }
  return [...hints.values()];
}

export function addRegistryEnvironmentHint(
  rows: readonly McpKeyValueDraft[],
  hint: McpRegistryEnvironmentHint,
): McpKeyValueDraft[] {
  if (rows.some((row) => row.key.trim() === hint.name)) return [...rows];
  return [...rows, { key: hint.name, value: '' }];
}

export function mcpConfigToDraft(config: McpServerConfig): McpConfigDraft {
  return {
    transport: config.command ? 'stdio' : 'streamable_http',
    command: config.command ?? '',
    argsText: (config.args ?? []).join('\n'),
    env: recordRows(config.env),
    url: config.url ?? '',
    httpHeaders: recordRows(config.http_headers),
    proxyId: config.proxyId ?? '',
    enabled: config.enabled !== false,
  };
}

function buildRecord(
  label: string,
  rows: readonly McpKeyValueDraft[],
  errors: string[],
  labels: McpConfigValidationLabels,
): Record<string, string> | undefined {
  const output: Record<string, string> = {};
  for (const [index, row] of rows.entries()) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!key) {
      errors.push(labels.missingRowName(label, index + 1));
      continue;
    }
    if (Object.hasOwn(output, key)) {
      errors.push(labels.duplicateRowName(label, key));
      continue;
    }
    output[key] = row.value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/** 换传输方式时另一半的字段必须一起清掉，否则 command 与 url 会同时存在 */
const STDIO_KEYS = ['command', 'args', 'env', 'cwd', 'enable_2026_protocol'] as const;
const HTTP_KEYS = [
  'url',
  'http_headers',
  'env_http_headers',
  'bearer_token_env_var',
  'oauth',
  'oauth_resource',
  'scopes',
  'proxyId',
] as const;

function omit(config: McpServerConfig, keys: readonly (keyof McpServerConfig)[]): McpServerConfig {
  const next = { ...config };
  for (const key of keys) delete next[key];
  return next;
}

export function buildMcpConfig(
  draft: McpConfigDraft,
  base: McpServerConfig,
  labels: McpConfigValidationLabels,
): McpConfigBuildResult {
  const errors: string[] = [];
  const writableBase = structuredClone(base);
  const config: McpServerConfig = draft.transport === 'stdio'
    ? omit(writableBase, [...HTTP_KEYS, 'command', 'args', 'env'])
    : omit(writableBase, [...STDIO_KEYS, 'url', 'http_headers', 'proxyId']);

  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (!command) errors.push(labels.commandRequired);
    else config.command = command;
    const args = lineValues(draft.argsText);
    if (args.length > 0) config.args = args;
    const env = buildRecord(labels.environmentVariables, draft.env, errors, labels);
    if (env) config.env = env;
  } else {
    const url = draft.url.trim();
    if (!url) {
      errors.push(labels.addressRequired);
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push(labels.addressProtocol);
        } else {
          config.url = url;
        }
      } catch {
        errors.push(labels.addressInvalid);
      }
    }
    const httpHeaders = buildRecord(labels.requestHeaders, draft.httpHeaders, errors, labels);
    if (httpHeaders) config.http_headers = httpHeaders;
    const proxyId = draft.proxyId.trim();
    if (proxyId) config.proxyId = proxyId;
  }

  if (draft.enabled) delete config.enabled;
  else config.enabled = false;

  return errors.length > 0 ? { success: false, errors } : { success: true, config };
}
