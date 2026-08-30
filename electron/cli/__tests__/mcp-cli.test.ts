import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../main.js';

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
  // --root 必须在 `--` 终止符之前，否则会落进 stdio 命令的 rest 参数
  const code = await runCli(['--root', root, ...args], {
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

describe('piskie mcp 命令组', () => {
  it('add（stdio 经 `--`）→ list → get → remove 全链', async () => {
    const root = await temporaryDirectory('piskie-cli-mcp-');

    const added = await execute(
      ['mcp', 'add', 'fs', '--env', 'FOO=bar', '--', 'npx', '-y', 'some-server', '/data'],
      root,
    );
    expect(added.code).toBe(0);
    expect(added.stdout?.command).toBe('mcp.add');
    expect((added.stdout?.data as Record<string, unknown>).scope).toBe('user');

    const listed = await execute(['mcp', 'list'], root);
    expect(listed.code).toBe(0);
    const items = listed.stdout?.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('fs');
    expect(items[0]!.transport).toBe('stdio');

    const got = await execute(['mcp', 'get', 'fs'], root);
    expect(got.code).toBe(0);
    const detail = got.stdout?.data as { config: { command: string; args: string[]; env: Record<string, string> } };
    expect(detail.config.command).toBe('npx');
    expect(detail.config.args).toEqual(['-y', 'some-server', '/data']);
    expect(detail.config.env).toEqual({ FOO: 'bar' });

    const removed = await execute(['mcp', 'remove', 'fs'], root);
    expect(removed.code).toBe(0);

    const after = await execute(['mcp', 'list'], root);
    expect(after.stdout?.data as unknown[]).toHaveLength(0);
  });

  it('--url 与 stdio 命令互斥、两者皆无为参数错误（exit 2）', async () => {
    const root = await temporaryDirectory('piskie-cli-mcp-');

    const both = await execute(
      ['mcp', 'add', 'x', '--url', 'https://e.com/mcp', '--', 'cmd'],
      root,
    );
    expect(both.code).toBe(2);
    expect((both.stderr?.error as Record<string, unknown>).code).toBe('CLI_ARGUMENT_INVALID');

    const neither = await execute(['mcp', 'add', 'x'], root);
    expect(neither.code).toBe(2);
  });

  it('--scope project 无 workspace 推断时报参数错误', async () => {
    const root = await temporaryDirectory('piskie-cli-mcp-');
    const previousCwd = process.cwd();
    const bareDir = await temporaryDirectory('piskie-cli-bare-');
    process.chdir(bareDir);
    try {
      const result = await execute(
        ['mcp', 'add', 'x', '--scope', 'project', '--', 'server'],
        root,
      );
      expect(result.code).toBe(2);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('--scope project --workspace 写 overlay 且记信任', async () => {
    const root = await temporaryDirectory('piskie-cli-mcp-');
    const workspace = await temporaryDirectory('piskie-cli-ws-');

    const added = await execute(
      ['mcp', 'add', 'repo-tool', '--scope', 'project', '--workspace', workspace, '--', 'server'],
      root,
    );
    expect(added.code).toBe(0);
    expect((added.stdout?.data as Record<string, unknown>).trusted).toBe(true);

    const listed = await execute(
      ['mcp', 'list', '--scope', 'project', '--workspace', workspace],
      root,
    );
    const items = listed.stdout?.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.trusted).toBe(true);
  });

  it('未知 mcp 子命令报参数错误', async () => {
    const root = await temporaryDirectory('piskie-cli-mcp-');
    const result = await execute(['mcp', 'bogus'], root);
    expect(result.code).toBe(2);
  });

  it('logout 无凭据时报 NO_CREDENTIALS', async () => {
    const root = await temporaryDirectory('piskie-cli-mcp-');
    await execute(['mcp', 'add', 'web', '--url', 'http://127.0.0.1:9/mcp'], root);
    const result = await execute(['mcp', 'logout', 'web'], root);
    expect(result.code).toBe(1);
    expect((result.stderr?.error as Record<string, unknown>).code).toBe('NO_CREDENTIALS');
  });
});
