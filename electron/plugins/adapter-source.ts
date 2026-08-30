import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { PluginPackageSource } from '@shared/types/plugin.js'

import { downloadArchive, extractZipSafely } from '../archive/secure-archive.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 120_000
const PACKAGE_TIMEOUT_MS = 120_000

export interface ResolvedPluginPackage {
  directory: string
  remote: boolean
  cleanup(): Promise<void>
}

export class PluginPackageSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginPackageSourceError'
  }
}

export async function resolvePluginPackageSource(source: PluginPackageSource): Promise<ResolvedPluginPackage> {
  switch (source.type) {
    case 'directory':
      return resolveDirectory(source.path)
    case 'git':
      return resolveGit(source)
    case 'npm':
      return resolveNpm(source)
    case 'archive':
      return resolveArchive(source)
  }
}

export function pluginPackageSourceLabel(source: PluginPackageSource): string {
  switch (source.type) {
    case 'directory': return source.path
    case 'git': {
      const pin = source.sha ?? source.ref
      return `${source.url}${pin ? `#${pin}` : ''}${source.subdirectory ? `:${source.subdirectory}` : ''}`
    }
    case 'npm': return `${source.package}${source.version ? `@${source.version}` : ''}`
    case 'archive': return source.url
  }
}

async function resolveDirectory(directory: string): Promise<ResolvedPluginPackage> {
  const resolved = path.resolve(directory)
  let stat
  try {
    stat = await fs.stat(resolved)
  } catch {
    throw new PluginPackageSourceError(`插件目录不存在：${resolved}`)
  }
  if (!stat.isDirectory()) throw new PluginPackageSourceError(`插件来源不是目录：${resolved}`)
  return { directory: resolved, remote: false, cleanup: async () => {} }
}

async function resolveGit(source: Extract<PluginPackageSource, { type: 'git' }>): Promise<ResolvedPluginPackage> {
  const temporary = await makeTemp('piskie-plugin-git-')
  const repository = path.join(temporary.directory, 'repository')
  try {
    if (source.sha) {
      await fs.mkdir(repository)
      await runGit(['init', repository])
      await runGit(['-C', repository, 'remote', 'add', 'origin', source.url])
      // sha 是权威 pin；fetch 失败时不回退 ref 或默认分支。
      await runGit(['-C', repository, 'fetch', '--depth', '1', 'origin', source.sha])
      await runGit(['-C', repository, 'checkout', '--detach', 'FETCH_HEAD'])
      const { stdout } = await runGit(['-C', repository, 'rev-parse', 'HEAD'])
      if (stdout.trim().toLowerCase() !== source.sha.toLowerCase()) {
        throw new PluginPackageSourceError(`git SHA 校验失败：期望 ${source.sha}，得到 ${stdout.trim()}`)
      }
    } else {
      const args = ['clone', '--depth', '1']
      if (source.ref) args.push('--branch', source.ref)
      args.push(source.url, repository)
      await runGit(args)
    }
    const directory = source.subdirectory
      ? containedSubdirectory(repository, source.subdirectory)
      : repository
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new PluginPackageSourceError(`git 插件子目录不存在：${source.subdirectory}`)
    return { directory, remote: true, cleanup: temporary.cleanup }
  } catch (error) {
    await temporary.cleanup()
    if (error instanceof PluginPackageSourceError) throw error
    throw new PluginPackageSourceError(`git 插件来源解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveNpm(source: Extract<PluginPackageSource, { type: 'npm' }>): Promise<ResolvedPluginPackage> {
  const temporary = await makeTemp('piskie-plugin-npm-')
  const packed = path.join(temporary.directory, 'packed')
  const extracted = path.join(temporary.directory, 'extracted')
  await fs.mkdir(packed)
  await fs.mkdir(extracted)
  const specifier = `${source.package}${source.version ? `@${source.version}` : ''}`
  const args = ['pack', specifier, '--json', '--pack-destination', packed]
  if (source.registry) args.push('--registry', validateRegistry(source.registry))
  try {
    const { stdout } = await execFileAsync('npm', args, {
      timeout: PACKAGE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    const report = JSON.parse(stdout) as Array<{ filename?: unknown }>
    const filename = report[0]?.filename
    if (typeof filename !== 'string') throw new Error('npm pack 未返回 tarball 文件名')
    const tarball = path.join(packed, path.basename(filename))
    await execFileAsync('tar', ['-xzf', tarball, '-C', extracted], { timeout: PACKAGE_TIMEOUT_MS })
    const directory = await descendSingleRoot(extracted)
    return { directory, remote: true, cleanup: temporary.cleanup }
  } catch (error) {
    await temporary.cleanup()
    throw new PluginPackageSourceError(`npm 插件来源解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveArchive(
  source: Extract<PluginPackageSource, { type: 'archive' }>,
): Promise<ResolvedPluginPackage> {
  const temporary = await makeTemp('piskie-plugin-archive-')
  const archive = path.join(temporary.directory, 'plugin.zip')
  const extracted = path.join(temporary.directory, 'extracted')
  try {
    await downloadArchive({
      url: source.url,
      destination: archive,
      expectedSha256: source.sha256,
    })
    await extractZipSafely({ archivePath: archive, destination: extracted })
    return { directory: await descendSingleRoot(extracted), remote: true, cleanup: temporary.cleanup }
  } catch (error) {
    await temporary.cleanup()
    throw new PluginPackageSourceError(`archive 插件来源解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
}

function containedSubdirectory(root: string, subdirectory: string): string {
  const candidate = path.resolve(root, subdirectory)
  const relative = path.relative(path.resolve(root), candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PluginPackageSourceError(`git 插件子目录越界：${subdirectory}`)
  }
  return candidate
}

function validateRegistry(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PluginPackageSourceError(`npm registry URL 无效：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PluginPackageSourceError('npm registry 必须使用 HTTP 或 HTTPS')
  }
  return url.toString()
}

async function descendSingleRoot(directory: string): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory())
  const files = entries.filter((entry) => entry.isFile())
  if (directories.length === 1 && files.length === 0) return path.join(directory, directories[0].name)
  return directory
}

async function makeTemp(prefix: string): Promise<{ directory: string; cleanup(): Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    directory,
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    },
  }
}
