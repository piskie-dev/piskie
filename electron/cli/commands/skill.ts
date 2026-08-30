import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createSkillsPort, type SkillsPort } from '../../skills/ports.js';
import { createMcpPort } from '../../mcp/ports.js';
import { createPluginsPort } from '../../plugins/ports.js';
import { createMarketPort } from '../../market/ports.js';
import { projectStatePathsForRead } from '../../skills/store/layout.js';
import { CliArgumentError, required } from '../../inference/config-cli/main.js';
import type { CliParsedArguments } from '../main.js';

export interface SkillCommandContext {
  port: SkillsPort;
  parsed: CliParsedArguments;
  subject?: string;
  configRoot: string;
}

export interface SkillCommandDefinition {
  action: string;
  usage: string;
  execute(context: SkillCommandContext): unknown | Promise<unknown>;
}

const SKILL_TYPES: ReadonlySet<string> = new Set(['browser', 'local']);

export const SKILL_COMMAND_DEFINITIONS: readonly SkillCommandDefinition[] = [
  {
    action: 'list',
    usage: 'piskie skill list [--type browser|local] [--scope user|project|all] [--json]',
    async execute({ port, parsed }) {
      const type = parseTypeOption(parsed);
      const scope = parseScopeOption(parsed, ['user', 'project', 'all'], 'user');
      let workspaces: string[] | undefined;
      if (scope === 'project') {
        workspaces = [await requireWorkspace(parsed)];
      } else if (scope === 'all') {
        const workspace = await resolveWorkspace(parsed);
        workspaces = workspace ? [workspace] : undefined;
      }
      return port.list({ type, scope, workspaces });
    },
  },
  {
    action: 'show',
    usage: 'piskie skill show <name> [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'skill name');
      const workspace = await resolveWorkspace(parsed);
      return port.show(name, workspace ? { workspace } : {});
    },
  },
  {
    action: 'install',
    usage: 'piskie skill install <path|zip|git-url|https-url|market-ref>'
      + ' [--scope user|project] [--workspace <dir>] [--force] [--allow-executable] [--json]',
    async execute({ port, parsed, subject }) {
      const source = required(subject, 'skill source');
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user');
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined;
      return port.install({
        source,
        scope,
        workspace,
        force: parsed.flag('force'),
        allowExecutable: parsed.flag('allow-executable'),
      });
    },
  },
  {
    action: 'remove',
    usage: 'piskie skill remove <name> [--scope user|project] [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'skill name');
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user');
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined;
      return port.remove(name, { scope, workspace });
    },
  },
  {
    action: 'enable',
    usage: 'piskie skill enable <name> [--json]',
    async execute({ port, subject }) {
      const name = required(subject, 'skill name');
      await port.enable(name);
      return { name, enabled: true };
    },
  },
  {
    action: 'disable',
    usage: 'piskie skill disable <name> [--json]',
    async execute({ port, subject }) {
      const name = required(subject, 'skill name');
      await port.disable(name);
      return { name, enabled: false };
    },
  },
  {
    action: 'search',
    usage: 'piskie skill search <query> [--remote] [--json]',
    async execute({ port, parsed, subject, configRoot }) {
      const query = required(subject, 'search query');
      if (parsed.flag('remote')) {
        const defaultWorkspaceDir = path.join(configRoot, 'workspace');
        const mcp = createMcpPort({ configRoot, defaultWorkspaceDir });
        const plugins = createPluginsPort({ configRoot, defaultWorkspaceDir, installedBy: 'piskie-cli' });
        const market = createMarketPort({ configRoot, skills: port, mcp, plugins });
        const page = await market.list({ query, kinds: ['skill'], refreshIfStale: true, limit: 10 });
        return page.entries;
      }
      const workspace = await resolveWorkspace(parsed);
      return port.search(query, workspace ? { workspaces: [workspace] } : {});
    },
  },
];

export const SKILL_COMMANDS = new Map(
  SKILL_COMMAND_DEFINITIONS.map((definition) => [definition.action, definition]),
);

/** CLI 侧技能端口：不带运行时供给（无内置技能枚举、无内存发布段） */
export function createCliSkillsPort(configRoot: string): SkillsPort {
  return createSkillsPort({
    defaultWorkspaceDir: path.join(configRoot, 'workspace'),
    installedBy: 'piskie-cli',
  });
}

function parseTypeOption(parsed: CliParsedArguments): string | undefined {
  const type = parsed.option('type');
  if (type !== undefined && !SKILL_TYPES.has(type)) {
    throw new CliArgumentError('--type must be browser or local');
  }
  return type;
}

export function parseScopeOption<T extends string>(
  parsed: CliParsedArguments,
  allowed: readonly T[],
  fallback: T,
): T {
  const scope = parsed.option('scope') ?? fallback;
  if (!(allowed as readonly string[]).includes(scope)) {
    throw new CliArgumentError(`--scope must be ${allowed.join(' or ')}`);
  }
  return scope as T;
}

/** 项目 workspace 解析：显式 --workspace 优先，否则 cwd 含项目状态目录时用 cwd。 */
export async function resolveWorkspace(parsed: CliParsedArguments): Promise<string | undefined> {
  const explicit = parsed.option('workspace');
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  for (const candidate of await projectStatePathsForRead(cwd)) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) return cwd;
    } catch {
      // Continue through the read-compatible project roots.
    }
  }
  return undefined;
}

export async function requireWorkspace(parsed: CliParsedArguments): Promise<string> {
  const workspace = await resolveWorkspace(parsed);
  if (!workspace) {
    throw new CliArgumentError(
      '--scope project requires --workspace, or run inside a project directory containing .piskie/',
    );
  }
  return workspace;
}
