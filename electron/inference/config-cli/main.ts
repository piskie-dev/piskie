#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { InferenceControlPlane } from '../control/control-plane.js';
import { InferenceConfigRepository, inferenceConfigPaths } from '../control/config-repository.js';
import { InferenceSelectionStore } from '../control/selection-store.js';
import { ComfyWorkflowAssetStore } from '../control/workflow-assets.js';
import { bootstrapInferenceConfig } from '../control/bootstrap-config.js';
import { LocalImageArtifactStore } from '../image/artifact-store.js';
import { createBuiltInInferenceDriverRegistry } from '../composition/built-in-drivers.js';
import { createNodeInferenceTransports } from '../composition/node-transport.js';
import { resolvePiskieConfigRoot } from './environment.js';
import { createConfigHost as composeConfigHost } from '../../config/host/composition.js';
import type { ConfigHost } from '../../config/host/config-host.js';
import type { ConfigCommandPort } from '../../config/host/config-command-port.js';
import { connectLocalConfigHost } from '../../config/host/local-transport.js';
import type { ConfigPlanRequest } from '../../../shared/types/config.js';

export interface ConfigCliIo {
  stdin?(): Promise<string>;
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface ConfigCliDependencies {
  createControlPlane(rootDirectory: string): InferenceControlPlane;
  createSelectionStore(rootDirectory: string): InferenceSelectionStore;
  createConfigHost(
    control: InferenceControlPlane,
    rootDirectory?: string,
    selections?: InferenceSelectionStore,
  ): ConfigHost;
  connectConfigHost(rootDirectory: string): Promise<ConfigCommandPort>;
  io: ConfigCliIo;
}

export const DEFAULT_IO: ConfigCliIo = {
  stdin: readProcessStdin,
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export interface ConfigCommandContext {
  host: ConfigCommandPort;
  io: ConfigCliIo;
  parsed: ParsedArguments;
  subject?: string;
}

export interface ConfigCommandDefinition {
  action: string;
  usage: string;
  alternateUsages?: readonly string[];
  requiresState: boolean;
  execute(context: ConfigCommandContext): unknown | Promise<unknown>;
}

export const CONFIG_COMMAND_DEFINITIONS: readonly ConfigCommandDefinition[] = [
  {
    action: 'domains',
    usage: 'piskie config domains --json',
    requiresState: false,
    execute: ({ host }) => host.domains(),
  },
  {
    action: 'describe',
    usage: 'piskie config describe <domain> --json',
    requiresState: false,
    execute: ({ host, subject }) => host.describe(required(subject, 'config domain')),
  },
  {
    action: 'show',
    usage: 'piskie config show <domain> --json',
    requiresState: true,
    execute: ({ host, subject }) => host.show(required(subject, 'config domain')),
  },
  {
    action: 'history',
    usage: 'piskie config history <domain> --json',
    requiresState: true,
    async execute({ host, subject }) {
      const domain = required(subject, 'config domain');
      return { domain, revisions: await host.history(domain) };
    },
  },
  {
    action: 'plan',
    usage: 'piskie config plan <domain> --changes-stdin --json',
    alternateUsages: ['piskie config plan <domain> --changes-file <file> --json'],
    requiresState: true,
    async execute({ host, io, parsed, subject }) {
      return host.createPlan(
        required(subject, 'config domain'),
        await readPlanRequest(parsed, io),
      );
    },
  },
  {
    action: 'validate',
    usage: 'piskie config validate <plan-id> --json',
    requiresState: true,
    execute: ({ host, subject }) => host.validate(required(subject, 'plan ID')),
  },
  {
    action: 'probe',
    usage: 'piskie config probe <plan-id> --level connectivity|smoke [--provider ID] [--model ID] --json',
    requiresState: true,
    execute({ host, parsed, subject }) {
      const level = parsed.option('level');
      if (level !== 'connectivity' && level !== 'smoke') {
        throw new CliArgumentError('--level must be connectivity or smoke');
      }
      const providerId = parsed.option('provider');
      const modelId = parsed.option('model');
      return host.probe(required(subject, 'plan ID'), {
        level,
        ...(providerId || modelId ? { target: { providerId, modelId } } : {}),
      });
    },
  },
  {
    action: 'apply',
    usage: 'piskie config apply <plan-id> --expected-revision N --json',
    requiresState: true,
    execute: ({ host, parsed, subject }) => host.apply(
      required(subject, 'plan ID'),
      nonnegativeInteger(parsed.option('expected-revision'), '--expected-revision'),
    ),
  },
  {
    action: 'verify',
    usage: 'piskie config verify <domain> [--revision N] --json',
    requiresState: true,
    execute({ host, parsed, subject }) {
      const revision = parsed.option('revision');
      return host.verify(
        required(subject, 'config domain'),
        revision === undefined ? undefined : nonnegativeInteger(revision, '--revision'),
      );
    },
  },
  {
    action: 'rollback',
    usage: 'piskie config rollback <domain> --to-revision N --json',
    requiresState: true,
    execute: ({ host, parsed, subject }) => host.rollback(
      required(subject, 'config domain'),
      nonnegativeInteger(parsed.option('to-revision'), '--to-revision'),
    ),
  },
];

const CONFIG_COMMANDS = new Map(
  CONFIG_COMMAND_DEFINITIONS.map((definition) => [definition.action, definition]),
);

export async function runConfigCli(
  argv: readonly string[],
  dependencies: Partial<ConfigCliDependencies> = {},
): Promise<number> {
  const io = dependencies.io ?? DEFAULT_IO;
  let command = 'unknown';
  try {
    const parsed = parseArguments(argv);
    const rootDirectory = parsed.option('root') ?? resolvePiskieConfigRoot();
    const [group, action, subject] = parsed.positionals;
    const configCommand = group === 'config' && action ? CONFIG_COMMANDS.get(action) : undefined;
    if (group === 'config' && !configCommand) {
      throw new CliArgumentError(`Unknown config command: ${action ?? ''}`.trim());
    }
    if (configCommand?.requiresState && shouldConnectRunningConfigHost(dependencies)) {
      command = `config.${configCommand.action}`;
      const configHost = await (dependencies.connectConfigHost ?? connectLocalConfigHost)(
        rootDirectory,
      );
      const data = await configCommand.execute({ host: configHost, io, parsed, subject });
      io.stdout(`${JSON.stringify({ ok: true, command, data }, null, 2)}\n`);
      return 0;
    }
    if (!dependencies.createControlPlane && requiresConfigState(group, action)) {
      await bootstrapInferenceConfig({
        rootDirectory,
        drivers: createDefaultDriverRegistry(rootDirectory),
      });
    }
    const control = (dependencies.createControlPlane ?? createDefaultControlPlane)(rootDirectory);
    const selections = (dependencies.createSelectionStore ?? createDefaultSelectionStore)(rootDirectory);
    const configHost = (dependencies.createConfigHost
      ?? ((inference, root = rootDirectory, selectionStore = selections) => composeConfigHost({
        rootDirectory: root,
        inference,
        selections: selectionStore,
      })))(control, rootDirectory, selections);
    if (requiresConfigState(group, action)) await configHost.prepare();
    command = [group, action].filter(Boolean).join('.');

    let data: unknown;
    if (configCommand) {
      data = await configCommand.execute({ host: configHost, io, parsed, subject });
    } else if (group === 'models' && action === 'query') {
      const gateway = parsed.option('gateway');
      if (gateway !== 'ai' && gateway !== 'image') {
        throw new CliArgumentError('--gateway must be ai or image');
      }
      const operation = parsed.option('operation');
      if (operation !== undefined && operation !== 'generate' && operation !== 'edit') {
        throw new CliArgumentError('--operation must be generate or edit');
      }
      data = await control.models(gateway, operation);
    } else if (group === 'drivers' && action === 'list') {
      data = control.drivers();
    } else if (group === 'drivers' && action === 'schema') {
      data = control.driverSchema(required(subject, 'driver ID'));
    } else if (group === 'workflows' && action === 'import') {
      if (subject !== 'comfyui') throw new CliArgumentError('Only workflows import comfyui is supported');
      data = await control.importComfyWorkflow(await fs.readFile(required(parsed.option('file'), '--file'), 'utf8'));
    } else if (group === 'workflows' && action === 'inspect') {
      data = control.inspectComfyWorkflow(required(subject, 'workflow asset ID'));
    } else if (group === 'workflows' && action === 'detect-bindings') {
      data = control.detectComfyWorkflowBindings(required(subject, 'workflow asset ID'));
    } else if (group === 'workflows' && action === 'validate') {
      data = control.validateComfyWorkflowBindings(
        required(subject, 'workflow asset ID'),
        parseJsonOption(required(parsed.option('bindings-json'), '--bindings-json'), '--bindings-json'),
        parseStringArrayOption(required(parsed.option('output-node-ids-json'), '--output-node-ids-json'), '--output-node-ids-json'),
      );
    } else if (group === 'help' || group === '--help' || group === '-h' || group === undefined) {
      command = 'help';
      data = usage();
    } else {
      throw new CliArgumentError(`Unknown command: ${parsed.positionals.join(' ')}`);
    }

    io.stdout(`${JSON.stringify({ ok: true, command, data }, null, 2)}\n`);
    return 0;
  } catch (cause) {
    const error = serializeError(cause);
    io.stderr(`${JSON.stringify({ ok: false, command, error }, null, 2)}\n`);
    return error.code === 'CLI_ARGUMENT_INVALID' ? 2 : 1;
  }
}

export function createDefaultControlPlane(rootDirectory: string): InferenceControlPlane {
  const paths = inferenceConfigPaths(rootDirectory);
  return new InferenceControlPlane({
    repository: new InferenceConfigRepository(paths),
    drivers: createDefaultDriverRegistry(rootDirectory),
    publisher: 'cli',
  });
}

export function createDefaultDriverRegistry(rootDirectory: string) {
  const paths = inferenceConfigPaths(rootDirectory);
  const artifacts = new LocalImageArtifactStore(paths.artifactDirectory);
  const workflows = new ComfyWorkflowAssetStore(paths.workflowDirectory);
  const transports = createNodeInferenceTransports(rootDirectory);
  return createBuiltInInferenceDriverRegistry({
    artifacts,
    workflows,
    openAi: { resolveFetch: transports.resolveFetch },
    anthropic: { resolveFetch: transports.resolveFetch },
    comfyui: {
      resolveFetch: transports.resolveFetch,
      resolveSocketFactory: transports.resolveSocketFactory,
    },
    imageHttp: { resolveFetch: transports.resolveFetch },
  });
}

export function createDefaultSelectionStore(rootDirectory: string): InferenceSelectionStore {
  return new InferenceSelectionStore(inferenceConfigPaths(rootDirectory));
}

export interface ParsedArguments {
  positionals: string[];
  option(name: string): string | undefined;
  flag(name: string): boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals > 2) {
      options.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    if (name === 'json' || name === 'changes-stdin') {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliArgumentError(`Option --${name} requires a value`);
    }
    options.set(name, value);
    index++;
  }
  return {
    positionals,
    option: (name) => {
      const value = options.get(name);
      return typeof value === 'string' ? value : undefined;
    },
    flag: (name) => options.get(name) === true,
  };
}

function requiresConfigState(group: string | undefined, action: string | undefined): boolean {
  if (group === undefined || group === 'help' || group === '--help' || group === '-h') return false;
  if (group === 'config') return action ? CONFIG_COMMANDS.get(action)?.requiresState ?? false : false;
  if (group === 'drivers' && (action === 'list' || action === 'schema')) return false;
  return true;
}

export function shouldConnectRunningConfigHost(
  dependencies: Partial<ConfigCliDependencies>,
): boolean {
  if (dependencies.connectConfigHost) return true;
  return !dependencies.createControlPlane
    && !dependencies.createSelectionStore
    && !dependencies.createConfigHost;
}

async function readPlanRequest(
  parsed: ParsedArguments,
  io: ConfigCliIo,
): Promise<ConfigPlanRequest> {
  const useStdin = parsed.flag('changes-stdin');
  const file = parsed.option('changes-file');
  if (Number(useStdin) + Number(file !== undefined) !== 1) {
    throw new CliArgumentError('config plan requires exactly one of --changes-stdin or --changes-file');
  }
  const label = useStdin ? '--changes-stdin' : '--changes-file';
  const source = useStdin
    ? await requiredStdin(io)
    : await fs.readFile(file!, 'utf8');
  const raw = parseJsonOption(source, label);
  if (!isRecord(raw)) throw new CliArgumentError(`${label} must contain a JSON object`);
  return raw as unknown as ConfigPlanRequest;
}

function nonnegativeInteger(value: string | undefined, label: string): number {
  const source = required(value, label);
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed < 0) throw new CliArgumentError(`${label} must be a non-negative integer`);
  return parsed;
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new CliArgumentError(`Missing ${label}`);
  return value;
}

export function serializeError(cause: unknown): {
  code: string;
  name: string;
  message: string;
  details?: unknown;
} {
  if (!(cause instanceof Error)) {
    return { code: 'UNEXPECTED_ERROR', name: 'Error', message: String(cause) };
  }
  const record = cause as Error & { code?: unknown; details?: unknown };
  return {
    code: typeof record.code === 'string' ? record.code : 'UNEXPECTED_ERROR',
    name: cause.name,
    message: cause.message,
    ...(record.details !== undefined && { details: record.details }),
  };
}

export function usage(): Record<string, unknown> {
  return {
    commands: [
      ...CONFIG_COMMAND_DEFINITIONS.flatMap((definition) => [
        definition.usage,
        ...(definition.alternateUsages ?? []),
      ]),
      'piskie models query --gateway ai|image [--operation generate|edit] --json',
      'piskie drivers list --json',
      'piskie drivers schema <driver-id> --json',
      'piskie workflows import comfyui --file workflow-api.json --json',
      'piskie workflows inspect|detect-bindings <workflow-asset-id> --json',
      "piskie workflows validate <workflow-asset-id> --bindings-json '{...}' --output-node-ids-json '[...]' --json",
    ],
    globalOptions: { root: 'Override the Piskie user-data root', json: 'Emit the stable JSON envelope' },
  };
}

async function requiredStdin(io: ConfigCliIo): Promise<string> {
  if (!io.stdin) throw new CliArgumentError('CLI stdin is unavailable');
  const source = await io.stdin();
  if (!source.trim()) throw new CliArgumentError('--changes-stdin received no JSON input');
  return source;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonOption(source: string, label: string): unknown {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new CliArgumentError(`${label} is not valid JSON: ${String(cause)}`);
  }
}

function parseStringArrayOption(source: string, label: string): readonly string[] {
  const raw = parseJsonOption(source, label);
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    throw new CliArgumentError(`${label} must be a JSON string array`);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CliArgumentError extends Error {
  readonly code = 'CLI_ARGUMENT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runConfigCli(process.argv.slice(2));
}
