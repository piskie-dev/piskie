import path from 'node:path'

import { CliArgumentError, required } from '../../inference/config-cli/main.js'
import { createMcpPort } from '../../mcp/ports.js'
import { createPluginsPort, type PluginsPort } from '../../plugins/ports.js'
import type { CliParsedArguments } from '../main.js'
import { parseScopeOption, requireWorkspace, resolveWorkspace } from './skill.js'

export interface PluginCommandContext {
  port: PluginsPort
  parsed: CliParsedArguments
  subject?: string
  configRoot: string
}

export interface PluginCommandDefinition {
  action: string
  usage: string
  execute(context: PluginCommandContext): unknown | Promise<unknown>
}

export function createCliPluginsPort(configRoot: string): PluginsPort {
  const defaultWorkspaceDir = path.join(configRoot, 'workspace')
  const mcp = createMcpPort({ configRoot, defaultWorkspaceDir })
  return createPluginsPort({
    configRoot,
    defaultWorkspaceDir,
    installedBy: 'piskie-cli',
    trustProjectServer: async (name, workspace, config) => {
      await mcp.trustConfiguration(name, workspace, config)
    },
    onboardMcpServer: (name, workspace, onboarding) => mcp.onboard(name, {
      workspace,
      login: onboarding?.login === true,
    }),
  })
}

export const PLUGIN_COMMAND_DEFINITIONS: readonly PluginCommandDefinition[] = [
  {
    action: 'install',
    usage: 'piskie plugin install <path|zip|git-url|market-ref> [--scope user|project]'
      + ' [--workspace <dir>] [--force] [--allow-executable] [--json]',
    async execute({ port, parsed, subject }) {
      const source = required(subject, 'plugin source')
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user')
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined
      return port.install({
        source,
        scope,
        workspace,
        force: parsed.flag('force'),
        allowExecutable: parsed.flag('allow-executable'),
      })
    },
  },
  {
    action: 'list',
    usage: 'piskie plugin list [--scope user|project|all] [--workspace <dir>] [--json]',
    async execute({ port, parsed }) {
      const scope = parseScopeOption(parsed, ['user', 'project', 'all'], 'all')
      let workspaces: string[] | undefined
      if (scope === 'project') workspaces = [await requireWorkspace(parsed)]
      else if (scope === 'all') {
        const workspace = await resolveWorkspace(parsed)
        if (workspace) workspaces = [workspace]
      }
      return port.list({ scope, workspaces })
    },
  },
  {
    action: 'show',
    usage: 'piskie plugin show <name> [--scope user|project] [--workspace <dir>] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'plugin name')
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user')
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined
      return port.show(name, { scope, workspace })
    },
  },
  {
    action: 'remove',
    usage: 'piskie plugin remove <name> [--scope user|project] [--workspace <dir>] [--purge] [--json]',
    async execute({ port, parsed, subject }) {
      const name = required(subject, 'plugin name')
      const scope = parseScopeOption(parsed, ['user', 'project'], 'user')
      const workspace = scope === 'project' ? await requireWorkspace(parsed) : undefined
      return port.remove(name, { scope, workspace, purge: parsed.flag('purge') })
    },
  },
  {
    action: 'marketplace',
    usage: 'piskie plugin marketplace add|list|remove [value] [--format openai|anthropic] [--json]',
    async execute({ port, parsed, subject }) {
      const subcommand = required(subject, 'plugin marketplace command')
      const value = parsed.positionals[3]
      if (subcommand === 'add') {
        const format = parsed.option('format')
        if (format !== 'openai' && format !== 'anthropic') {
          throw new CliArgumentError('--format 必须显式指定 openai 或 anthropic')
        }
        return port.marketplace.add(format, required(value, 'marketplace git URL'), parsed.option('ref'))
      }
      if (subcommand === 'list') return port.marketplace.list()
      if (subcommand === 'remove') return port.marketplace.remove(required(value, 'marketplace name'))
      throw new CliArgumentError(`Unknown plugin marketplace command: ${subcommand}`)
    },
  },
]

export const PLUGIN_COMMANDS = new Map(
  PLUGIN_COMMAND_DEFINITIONS.map((definition) => [definition.action, definition]),
)
