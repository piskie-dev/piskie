#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import {
  CliArgumentError,
  DEFAULT_IO,
  runConfigCli,
  serializeError,
  usage as configUsage,
  type ConfigCliDependencies,
  type ConfigCliIo,
} from '../inference/config-cli/main.js';
import { initializeCliEnvironment } from './environment.js';
import { executeConfigCommand } from './commands/config.js';
import { createCliMcpPort, MCP_COMMAND_DEFINITIONS, MCP_COMMANDS } from './commands/mcp.js';
import {
  createCliPluginsPort,
  PLUGIN_COMMAND_DEFINITIONS,
  PLUGIN_COMMANDS,
} from './commands/plugin.js';
import { createCliSkillsPort, SKILL_COMMAND_DEFINITIONS, SKILL_COMMANDS } from './commands/skill.js';

/**
 * piskie CLI 统一入口：两级路由「组 → 命令表」。
 * config 组执行 inference 域导出的命令定义表；skill 组执行本域命令表；
 * models/drivers/workflows 组委派 runConfigCli 执行。
 * 输出信封 {ok, command, data|error}，退出码 0 成功 / 1 失败 / 2 参数错误。
 */
export async function runCli(
  argv: readonly string[],
  dependencies: Partial<ConfigCliDependencies> = {},
): Promise<number> {
  const io = dependencies.io ?? DEFAULT_IO;
  let command = 'unknown';
  try {
    const parsed = parseCliArguments(argv);
    const [group, action, subject] = parsed.positionals;
    const { configRoot } = initializeCliEnvironment(parsed.option('root'));

    if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
      command = 'help';
      emitSuccess(io, command, combinedUsage());
      return 0;
    }

    if (group === 'config') {
      const data = await executeConfigCommand({
        action,
        subject,
        parsed,
        io,
        rootDirectory: configRoot,
        dependencies,
        onExecute: () => {
          command = `config.${action}`;
        },
      });
      emitSuccess(io, command, data);
      return 0;
    }

    if (group === 'skill') {
      const definition = action ? SKILL_COMMANDS.get(action) : undefined;
      if (!definition) {
        throw new CliArgumentError(`Unknown skill command: ${action ?? ''}`.trim());
      }
      command = `skill.${action}`;
      const port = createCliSkillsPort(configRoot);
      const data = await definition.execute({ port, parsed, subject, configRoot });
      emitSuccess(io, command, data);
      return 0;
    }

    if (group === 'mcp') {
      const definition = action ? MCP_COMMANDS.get(action) : undefined;
      if (!definition) {
        throw new CliArgumentError(`Unknown mcp command: ${action ?? ''}`.trim());
      }
      command = `mcp.${action}`;
      const port = createCliMcpPort(configRoot);
      const data = await definition.execute({ port, parsed, subject, configRoot });
      emitSuccess(io, command, data);
      return 0;
    }

    if (group === 'plugin') {
      const definition = action ? PLUGIN_COMMANDS.get(action) : undefined;
      if (!definition) {
        throw new CliArgumentError(`Unknown plugin command: ${action ?? ''}`.trim());
      }
      command = `plugin.${action}`;
      const port = createCliPluginsPort(configRoot);
      const data = await definition.execute({ port, parsed, subject, configRoot });
      emitSuccess(io, command, data);
      return 0;
    }

    return await runConfigCli(argv, dependencies);
  } catch (cause) {
    const error = serializeError(cause);
    io.stderr(`${JSON.stringify({ ok: false, command, error }, null, 2)}\n`);
    return error.code === 'CLI_ARGUMENT_INVALID' ? 2 : 1;
  }
}

function emitSuccess(io: ConfigCliIo, command: string, data: unknown): void {
  io.stdout(`${JSON.stringify({ ok: true, command, data }, null, 2)}\n`);
}

function combinedUsage(): Record<string, unknown> {
  const base = configUsage();
  const commands = [
    ...(Array.isArray(base.commands) ? (base.commands as string[]) : []),
    ...SKILL_COMMAND_DEFINITIONS.map((definition) => definition.usage),
    ...MCP_COMMAND_DEFINITIONS.map((definition) => definition.usage),
    ...PLUGIN_COMMAND_DEFINITIONS.map((definition) => definition.usage),
  ];
  return { ...base, commands };
}

/** 无值即真的开关型选项；其余 --key 一律要求携带值 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'help',
  'json',
  'changes-stdin',
  'force',
  'allow-executable',
  'remote',
  'all',
  'purge',
]);

export interface CliParsedArguments {
  positionals: string[];
  /** `--` 终止符之后的原样参数（不做选项解析） */
  rest: string[];
  /** 最后一次出现的值（与重复覆盖语义一致） */
  option(name: string): string | undefined;
  /** 同名选项的全部值（按出现顺序） */
  options(name: string): string[];
  flag(name: string): boolean;
}

export function parseCliArguments(argv: readonly string[]): CliParsedArguments {
  const positionals: string[] = [];
  const rest: string[] = [];
  const values = new Map<string, Array<string | true>>();
  const record = (name: string, value: string | true): void => {
    const list = values.get(name);
    if (list) list.push(value);
    else values.set(name, [value]);
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals > 2) {
      record(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      record(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliArgumentError(`Option --${name} requires a value`);
    }
    record(name, value);
    index++;
  }
  return {
    positionals,
    rest,
    option: (name) => {
      const list = values.get(name);
      const last = list?.[list.length - 1];
      return typeof last === 'string' ? last : undefined;
    },
    options: (name) =>
      (values.get(name) ?? []).filter((value): value is string => typeof value === 'string'),
    flag: (name) => {
      const list = values.get(name);
      return list?.[list.length - 1] === true;
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
