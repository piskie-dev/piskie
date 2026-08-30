import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import type { McpOnboardingResult, McpServerConfig } from '@shared/types/mcp.js'
import type { PluginInfo, PluginMarketplaceFormat, PluginScope } from '@shared/types/plugin.js'

import { validateSkillDir } from '../skills/install/validate.js'
import { projectPluginsRootsForRead } from '../skills/store/layout.js'
import {
  addPluginMarketplaceSource,
  listPluginMarketplaceSources,
  removePluginMarketplaceSource,
} from './marketplace.js'
import { readPiskieAdapterMetadata, readPluginManifestFromDir } from './manifest.js'
import { installPlugin, removePlugin, type InstallPluginRequest } from './install.js'
import { parsePluginMcpFile } from './mcp-members.js'
import { globalPluginsRoot, pluginDataDir, readPluginsFile } from './store.js'

export interface PluginsPortOptions {
  configRoot: string
  defaultWorkspaceDir?: string
  installedBy?: string
  trustProjectServer?(name: string, workspace: string, config: McpServerConfig): Promise<void>
  onboardMcpServer?(
    name: string,
    workspace?: string,
    options?: { login?: boolean },
  ): Promise<McpOnboardingResult>
  onChanged?(): void
}

export interface PluginsPort {
  install(request: InstallPluginRequest, options?: { loginMcp?: boolean }): Promise<PluginInfo>
  list(options?: { scope?: PluginScope | 'all'; workspaces?: string[] }): Promise<PluginInfo[]>
  show(name: string, options?: { scope?: PluginScope; workspace?: string }): Promise<PluginInfo>
  remove(name: string, options?: { scope?: PluginScope; workspace?: string; purge?: boolean }): Promise<{
    name: string
    scope: PluginScope
    purged: boolean
  }>
  marketplace: {
    add(format: PluginMarketplaceFormat, url: string, ref?: string): ReturnType<typeof addPluginMarketplaceSource>
    list(): ReturnType<typeof listPluginMarketplaceSources>
    remove(name: string): ReturnType<typeof removePluginMarketplaceSource>
  }
}

export function createPluginsPort(options: PluginsPortOptions): PluginsPort {
  const scanRoot = async (root: string, scope: PluginScope, sourceByName?: Map<string, string>): Promise<PluginInfo[]> => {
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const result: PluginInfo[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      const pluginDir = path.join(root, entry.name)
      const manifest = await readPluginManifestFromDir(pluginDir)
      if (!manifest.ok) continue
      const skills = []
      let skillEntries: Dirent[]
      try {
        skillEntries = await fs.readdir(path.join(pluginDir, 'skills'), { withFileTypes: true })
      } catch {
        skillEntries = []
      }
      for (const skillEntry of skillEntries) {
        if (!skillEntry.isDirectory()) continue
        const validation = await validateSkillDir(path.join(pluginDir, 'skills', skillEntry.name), {
          directoryName: skillEntry.name,
        })
        if (!validation.parse.manifest) continue
        skills.push({
          name: validation.parse.manifest.name,
          executionType: validation.executionType,
          type: validation.parse.manifest.type,
        } as const)
      }
      const mcp = await parsePluginMcpFile({
        pluginDir,
        pluginName: manifest.manifest.name,
        dataDir: pluginDataDir(options.configRoot, manifest.manifest.name),
      })
      const adapter = readPiskieAdapterMetadata(manifest.manifest)
      result.push({
        name: manifest.manifest.name,
        version: manifest.manifest.version,
        description: manifest.manifest.description,
        source: sourceByName?.get(manifest.manifest.name) ?? pluginDir,
        scope,
        path: pluginDir,
        manifest: manifest.manifest,
        members: {
          skills,
          mcpServers: Object.entries(mcp.servers).map(([name, config]) => ({
            name,
            transport: config.command ? 'stdio' : 'streamable_http',
            command: config.command,
            args: config.args,
            url: config.url,
          })),
        },
        warnings: [
          ...manifest.warnings,
          ...adapter.warnings,
          ...mcp.warnings,
          ...mcp.issues.map((issue) => issue.message),
        ],
        compatibility: adapter.compatibility,
      })
    }
    return result
  }

  return {
    async install(request, installOptions = {}) {
      const installed = await installPlugin(options.configRoot, {
        defaultWorkspaceDir: options.defaultWorkspaceDir,
        installedBy: options.installedBy,
        ...request,
      }, {
        trustProjectServer: options.trustProjectServer,
        onChanged: options.onChanged,
      })
      if (!options.onboardMcpServer || installed.members.mcpServers.length === 0) return installed

      const warnings = [...(installed.warnings ?? [])]
      for (const server of installed.members.mcpServers) {
        try {
          const onboarding = await options.onboardMcpServer(
            server.name,
            request.workspace,
            { login: installOptions.loginMcp === true },
          )
          warnings.push(...onboarding.warnings.map((warning) => `${server.name}: ${warning}`))
        } catch (error) {
          warnings.push(`${server.name}: MCP onboarding 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { ...installed, warnings: warnings.length > 0 ? warnings : undefined }
    },

    async list(listOptions = {}) {
      const scope = listOptions.scope ?? 'all'
      const result: PluginInfo[] = []
      if (scope === 'user' || scope === 'all') {
        const store = await readPluginsFile(options.configRoot)
        const sources = new Map(store.plugins.map((record) => [record.name, record.source]))
        result.push(...await scanRoot(globalPluginsRoot(options.configRoot), 'user', sources))
      }
      if ((scope === 'project' || scope === 'all') && listOptions.workspaces) {
        for (const workspace of listOptions.workspaces) {
          const byName = new Map<string, PluginInfo>()
          for (const root of await projectPluginsRootsForRead(workspace)) {
            for (const plugin of await scanRoot(root, 'project')) byName.set(plugin.name, plugin)
          }
          result.push(...byName.values())
        }
      }
      return result.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
    },

    async show(name, showOptions = {}) {
      const scope = showOptions.scope ?? 'user'
      const workspaces = showOptions.workspace ? [showOptions.workspace] : undefined
      const plugins = await this.list({ scope, workspaces })
      const plugin = plugins.find((item) => item.name === name)
      if (!plugin) throw new Error(`插件不存在：${name}`)
      return plugin
    },

    remove: (name, removeOptions = {}) => removePlugin(options.configRoot, {
      name,
      scope: removeOptions.scope,
      workspace: removeOptions.workspace,
      purge: removeOptions.purge,
    }, { onChanged: options.onChanged }),

    marketplace: {
      add: (format, url, ref) => addPluginMarketplaceSource(options.configRoot, format, url, ref),
      list: () => listPluginMarketplaceSources(options.configRoot),
      remove: (name) => removePluginMarketplaceSource(options.configRoot, name),
    },
  }
}
