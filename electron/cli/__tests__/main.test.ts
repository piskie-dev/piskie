import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getPilotRoot } from '@electron/piskiepilot/paths.js';
import { writeMarketCache } from '../../market/cache.js';
import {
  addCustomMarketSource,
  BUILTIN_MARKET_SOURCES,
  refreshMarketSource,
} from '../../market/catalog.js';

import { initializeCliEnvironment, resolvePilotRoot } from '../environment.js';
import { parseCliArguments, runCli } from '../main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

interface CliResult {
  code: number;
  stdout?: Record<string, unknown>;
  stderr?: Record<string, unknown>;
}

async function execute(args: string[], root: string): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await runCli([...args, '--root', root], {
    io: {
      stdin: async () => '',
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
  });
  return {
    code,
    stdout: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : undefined,
    stderr: stderr ? (JSON.parse(stderr) as Record<string, unknown>) : undefined,
  };
}

async function makeSkillSource(name: string, description = `${name} 的说明`): Promise<string> {
  const sourceRoot = await temporaryDirectory('piskie-cli-skill-src-');
  const dir = path.join(sourceRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n正文内容\n`,
    'utf8',
  );
  return dir;
}

describe('parseCliArguments', () => {
  it('keeps every value of a repeated option and reports the last one as the scalar', () => {
    const parsed = parseCliArguments(['mcp', 'add', '--env', 'A=1', '--env', 'B=2']);
    expect(parsed.positionals).toEqual(['mcp', 'add']);
    expect(parsed.options('env')).toEqual(['A=1', 'B=2']);
    expect(parsed.option('env')).toBe('B=2');
  });

  it('stops option parsing at the -- terminator and preserves the remainder verbatim', () => {
    const parsed = parseCliArguments([
      'mcp', 'add', 'srv', '--env', 'K=V', '--', 'node', 'server.js', '--port', '3000',
    ]);
    expect(parsed.positionals).toEqual(['mcp', 'add', 'srv']);
    expect(parsed.rest).toEqual(['node', 'server.js', '--port', '3000']);
    expect(parsed.options('port')).toEqual([]);
    expect(parsed.option('env')).toBe('K=V');
  });

  it('treats the full boolean flag set as valueless switches', () => {
    const parsed = parseCliArguments([
      '--help', '--json', '--changes-stdin', '--force', '--allow-executable', '--remote', '--all',
      '--purge',
    ]);
    expect(parsed.positionals).toEqual([]);
    for (const flag of [
      'help',
      'json',
      'changes-stdin',
      'force',
      'allow-executable',
      'remote',
      'all',
      'purge',
    ]) {
      expect(parsed.flag(flag)).toBe(true);
    }
    expect(parsed.flag('workspace')).toBe(false);
  });

  it('supports --key=value and rejects value options without a value', () => {
    const parsed = parseCliArguments(['--workspace=/tmp/ws']);
    expect(parsed.option('workspace')).toBe('/tmp/ws');
    expect(() => parseCliArguments(['--workspace'])).toThrowError(/requires a value/);
    expect(() => parseCliArguments(['--workspace', '--json'])).toThrowError(/requires a value/);
  });
});

describe('initializeCliEnvironment', () => {
  it('resolves the config root and injects the pilot root', async () => {
    const root = await temporaryDirectory('piskie-cli-env-');
    const environment = initializeCliEnvironment(root);
    expect(environment.configRoot).toBe(path.resolve(root));
    expect(environment.pilotRoot).toBe(path.join(path.resolve(root), 'piskiepilot'));
    expect(environment.pilotRoot).toBe(resolvePilotRoot(environment.configRoot));
    expect(getPilotRoot()).toBe(environment.pilotRoot);
  });
});

describe('piskie skill 命令组', () => {
  it('lists an empty root as an empty JSON envelope with exit 0', async () => {
    const root = await temporaryDirectory('piskie-cli-skill-');
    const result = await execute(['skill', 'list', '--json'], root);
    expect(result).toMatchObject({
      code: 0,
      stdout: { ok: true, command: 'skill.list', data: [] },
    });
    expect(result.stderr).toBeUndefined();
  });

  it('installs a local directory skill into the pilot skills root', async () => {
    const root = await temporaryDirectory('piskie-cli-skill-');
    const source = await makeSkillSource('pdf-tools');

    const installed = await execute(['skill', 'install', source, '--json'], root);
    expect(installed).toMatchObject({
      code: 0,
      stdout: {
        ok: true,
        command: 'skill.install',
        data: {
          name: 'pdf-tools',
          scope: 'user',
          executionType: 'knowledge',
          type: 'local',
          registryRevision: 1,
        },
      },
    });
    expect(
      existsSync(path.join(root, 'piskiepilot', 'skills', 'local', 'pdf-tools', 'SKILL.md')),
    ).toBe(true);

    const listed = await execute(['skill', 'list', '--json'], root);
    expect(listed.code).toBe(0);
    expect(listed.stdout?.data).toMatchObject([
      { name: 'pdf-tools', scope: 'user', enabled: true, executionType: 'knowledge' },
    ]);

    const shown = await execute(['skill', 'show', 'pdf-tools', '--json'], root);
    expect(shown.code).toBe(0);
    expect(shown.stdout?.data).toMatchObject({ name: 'pdf-tools' });
    expect((shown.stdout?.data as { files: string[] }).files).toContain('SKILL.md');
  });

  it('maps SKILL_EXISTS to exit 1 with the pipeline error code and allows --force', async () => {
    const root = await temporaryDirectory('piskie-cli-skill-');
    const source = await makeSkillSource('dup-skill');

    await execute(['skill', 'install', source, '--json'], root);
    const duplicate = await execute(['skill', 'install', source, '--json'], root);
    expect(duplicate).toMatchObject({
      code: 1,
      stderr: {
        ok: false,
        command: 'skill.install',
        error: { code: 'SKILL_EXISTS', name: 'SkillPipelineError' },
      },
    });

    const forced = await execute(['skill', 'install', source, '--force', '--json'], root);
    expect(forced).toMatchObject({
      code: 0,
      stdout: { data: { name: 'dup-skill', registryRevision: 2 } },
    });
  });

  it('supports enable/disable/remove and reports SKILL_NOT_FOUND for a missing skill', async () => {
    const root = await temporaryDirectory('piskie-cli-skill-');
    const source = await makeSkillSource('toggle-skill');
    await execute(['skill', 'install', source, '--json'], root);

    const disabled = await execute(['skill', 'disable', 'toggle-skill', '--json'], root);
    expect(disabled).toMatchObject({
      code: 0,
      stdout: { command: 'skill.disable', data: { name: 'toggle-skill', enabled: false } },
    });
    const listed = await execute(['skill', 'list', '--json'], root);
    expect(listed.stdout?.data).toMatchObject([{ name: 'toggle-skill', enabled: false }]);

    const enabled = await execute(['skill', 'enable', 'toggle-skill', '--json'], root);
    expect(enabled).toMatchObject({ code: 0, stdout: { data: { enabled: true } } });

    const removed = await execute(['skill', 'remove', 'toggle-skill', '--json'], root);
    expect(removed).toMatchObject({
      code: 0,
      stdout: { command: 'skill.remove', data: { name: 'toggle-skill' } },
    });
    await expect(execute(['skill', 'show', 'toggle-skill', '--json'], root)).resolves.toMatchObject({
      code: 1,
      stderr: { error: { code: 'SKILL_NOT_FOUND' } },
    });
  });

  it('searches locally by default and uses the shared market catalog with --remote', async () => {
    const root = await temporaryDirectory('piskie-cli-skill-');
    const source = await makeSkillSource('pdf-tools', '处理 PDF 文件');
    await execute(['skill', 'install', source, '--json'], root);

    const local = await execute(['skill', 'search', 'pdf', '--json'], root);
    expect(local.code).toBe(0);
    expect(local.stdout?.data).toMatchObject([{ name: 'pdf-tools' }]);

    const remoteSource = await addCustomMarketSource(root, {
      name: 'CLI fixture skills',
      kind: 'git-skills',
      url: path.dirname(source),
    });
    await refreshMarketSource(root, remoteSource);
    await Promise.all(BUILTIN_MARKET_SOURCES.map((builtin) => writeMarketCache(root, builtin.id, {
      entries: [],
      warnings: [],
    })));

    const remote = await execute(['skill', 'search', 'pdf', '--remote', '--json'], root);
    expect(remote).toMatchObject({
      code: 0,
      stdout: { command: 'skill.search', data: [{ name: 'pdf-tools', sourceName: 'CLI fixture skills' }] },
    });
  });

  it('returns CLI_ARGUMENT_INVALID with exit 2 for unknown commands and bad arguments', async () => {
    const root = await temporaryDirectory('piskie-cli-skill-');

    await expect(execute(['skill', 'frobnicate', '--json'], root)).resolves.toMatchObject({
      code: 2,
      stderr: { ok: false, error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
    await expect(execute(['skill', 'install', '--json'], root)).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID', message: 'Missing skill source' } },
    });
    await expect(execute(['skill', 'list', '--scope', 'bogus', '--json'], root)).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
    await expect(execute(['skill', 'list', '--type', 'bogus', '--json'], root)).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
    await expect(execute(['skill', 'list', '--scope', 'project', '--json'], root)).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
  });
});

describe('config 组经新入口', () => {
  it('serves config domains through the mounted definition table', async () => {
    const root = await temporaryDirectory('piskie-cli-config-');
    const result = await execute(['config', 'domains', '--json'], root);
    expect(result).toMatchObject({ code: 0, stdout: { ok: true, command: 'config.domains' } });
    expect(result.stdout?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'inference' })]),
    );
  });

  it('rejects unknown config actions with exit 2', async () => {
    const root = await temporaryDirectory('piskie-cli-config-');
    await expect(execute(['config', 'bogus', '--json'], root)).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
  });

  it('requires the running Electron ConfigHost for stateful config commands', async () => {
    const root = await temporaryDirectory('piskie-cli-config-');
    await expect(execute(['config', 'show', 'app-settings', '--json'], root)).resolves.toMatchObject({
      code: 1,
      stderr: {
        command: 'config.show',
        error: { code: 'CONFIG_HOST_UNAVAILABLE' },
      },
    });
  });

  it('delegates drivers/models/workflows groups to the config CLI', async () => {
    const root = await temporaryDirectory('piskie-cli-config-');
    const result = await execute(['drivers', 'list', '--json'], root);
    expect(result).toMatchObject({ code: 0, stdout: { ok: true, command: 'drivers.list' } });
  });
});

describe('help', () => {
  it('includes both config and skill command usages', async () => {
    const root = await temporaryDirectory('piskie-cli-help-');
    const result = await execute(['help', '--json'], root);
    expect(result.code).toBe(0);
    const commands = (result.stdout?.data as { commands: string[] }).commands;
    expect(commands).toContain('piskie config plan <domain> --changes-stdin --json');
    expect(commands).toContain(
      'piskie skill list [--type browser|local] [--scope user|project|all] [--json]',
    );
    expect(commands).toContain('piskie skill search <query> [--remote] [--json]');
  });

  it('accepts the conventional --help alias without requiring a value', async () => {
    const root = await temporaryDirectory('piskie-cli-help-');
    await expect(execute(['--help'], root)).resolves.toMatchObject({
      code: 0,
      stdout: { ok: true, command: 'help' },
    });
  });
});
