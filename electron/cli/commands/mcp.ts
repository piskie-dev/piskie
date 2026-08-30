import path from 'node:path';

import { CliArgumentError, required } from '../../inference/config-cli/main.js';
import { createMcpPort, McpPortError, type McpPort } from '../../mcp/ports.js';
import type { McpServerConfig } from '../../../shared/types/mcp.js';
import type { CliParsedArguments } from '../main.js';
import { parseScopeOption, requireWorkspace, resolveWorkspace } from './skill.js';

export interface McpCommandContext {
  port: McpPort;
  parsed: CliParsedArguments;
  subject?: string;
  configRoot: string;
}

export interface McpCommandDefinition {
  action: string;
  usage: string;
  execute(context: McpCommandContext): unknown | Promise<unknown>;
}

export function createCliMcpPort(configRoot: string): McpPort {
  return createMcpPort({
    configRoot,
    defaultWorkspaceDir: path.join(configRoot, 'workspace'),
  });
}

/** 进度类输出（授权 URL 等）走 stderr，不污染 stdout 的 JSON 信封 */
function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseEnvOptions(parsed: CliParsedArguments): Record<string, string> | undefined {
  const pairs = parsed.options('env');
  if (pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new CliArgumentError(`--env 需要 K=V 形式，收到：${pair}`);
    env[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return env;
}

function parseScopesOption(parsed: CliParsedArguments): string[] | undefined {
  const raw = parsed.option('scopes');
  if (raw === undefined) return undefined;
  const scopes = raw.split(',').map((scope) => scope.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

/** command/url 二选一判别传输，不写 type 字段 */
function buildAddConfig(parsed: CliParsedArguments): McpServerConfig {
  const url = parsed.option('url');
  const rest = parsed.rest;
  if (url && rest.length > 0) {
    throw new CliArgumentError('--url 与 stdio 命令（`-- <command> [args...]`）互斥');
  }
  if (!url && rest.length === 0) {
    throw new CliArgumentError('需要 --url <URL>（streamable_http）或 `-- <command> [args...]`（stdio）之一');
  }

  if (url) {
    const clientId = parsed.option('oauth-client-id');
    const config: McpServerConfig = {
      url,
      bearer_token_env_var: parsed.option('bearer-token-env-var'),
      oauth: clientId ? { client_id: clientId } : undefined,
      oauth_resource: parsed.option('oauth-resource'),
      scopes: parseScopesOption(parsed),
      proxyId: parsed.option('proxy'),
    };
    return pruneUndefined(config);
  }

  const config: McpServerConfig = {
    command: rest[0],
    args: rest.length > 1 ? rest.slice(1) : undefined,
    env: parseEnvOptions(parsed),
    cwd: parsed.option('cwd'),
  };
  return pruneUndefined(config);
}

function pruneUndefined(config: McpServerConfig): McpServerConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as McpServerConfig;
}

export const MCP_COMMAND_DEFINITIONS: readonly McpCommandDefinition[] = [
  {
    action: 'add',
    usage: 'piskie mcp add <name> (--url <URL> [--proxy ID] [--bearer-token-env-var E] [--oauth-client-id ID]'
      + ' [--oauth-resource RES] [--scopes S,S] | [--env K=V ...] [--cwd DIR]'
      + ' -- <command> [args...])'
      + ' [--scope user|project] [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user');
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined;
      const config = buildAddConfig(parsed);
      const added = await port.add({ name, scope, workspace, config });
      const onboarding = await port.onboard(name, { workspace, login: true, log: progress });
      for (const warning of onboarding.warnings) progress(warning);
      return { ...added, onboarding };
    },
  },
  {
    action: 'list',
    usage: 'piskie mcp list [--scope user|project|all] [--workspace <dir>] [--json]',
    async execute({ port, parsed }) {
      const scope = parseScopeOption(parsed, ['user', 'project', 'all'], 'all');
      let workspace: string | undefined;
      if (scope === 'project') {
        workspace = await requireWorkspace(parsed);
      } else if (scope === 'all') {
        workspace = await resolveWorkspace(parsed);
      }
      return port.list({ scope, workspace });
    },
  },
  {
    action: 'get',
    usage: 'piskie mcp get <name> [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const workspace = await resolveWorkspace(parsed);
      return port.get(name, workspace ? { workspace } : {});
    },
  },
  {
    action: 'remove',
    usage: 'piskie mcp remove <name> [--scope user|project] [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user');
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined;
      return port.remove(name, { scope, workspace });
    },
  },
  {
    action: 'trust',
    usage: 'piskie mcp trust <name> --workspace <dir> [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const workspace = await requireWorkspace(parsed);
      return port.trust(name, workspace);
    },
  },
  {
    action: 'probe',
    usage: 'piskie mcp probe <name> [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const workspace = await resolveWorkspace(parsed);
      const snapshot = await port.probe(name, workspace ? { workspace } : {});
      return {
        server: snapshot.server,
        protocolVersion: snapshot.protocolVersion,
        toolCount: snapshot.tools.length,
        tools: snapshot.tools.map((tool) => tool.name),
      };
    },
  },
  {
    action: 'login',
    usage: 'piskie mcp login <name> [--scopes S,S] [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const workspace = await resolveWorkspace(parsed);
      const result = await port.login(name, {
        workspace,
        scopes: parseScopesOption(parsed),
        log: progress,
      });
      return { name, issuer: result.issuer, scope: result.scope, expiresAt: result.expiresAt };
    },
  },
  {
    action: 'logout',
    usage: 'piskie mcp logout <name> [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'server name');
      const workspace = await resolveWorkspace(parsed);
      const result = await port.logout(name, { workspace });
      if (!result.removed) {
        throw new McpPortError('NO_CREDENTIALS', `MCP server "${name}" 没有已存储的 OAuth 凭据`);
      }
      return { name, loggedOut: true };
    },
  },
  {
    action: 'search',
    usage: 'piskie mcp search <query> [--json]',
    async execute({ port, subject }) {
      const query = required(subject, 'search query');
      return port.search(query);
    },
  },
];

export const MCP_COMMANDS = new Map(
  MCP_COMMAND_DEFINITIONS.map((definition) => [definition.action, definition]),
);
