import {
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';

import { createUuid } from '../../../shared/utils/identifiers.js';
import type {
  ConfigApplyReceipt,
  ConfigDescriptor,
  ConfigDomainSummary,
  ConfigPlanIdentity,
  ConfigPlanRequest,
  ConfigProbeRequest,
} from '../../../shared/types/config.js';
import type { LocalConfigEndpointAdapter } from '../../transport/local/config-host-endpoint.js';
import { configFileWriter } from '../core/atomic-file-writer.js';
import type { ConfigCommandPort } from './config-command-port.js';

const LOCAL_CONFIG_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

const CONFIG_METHODS = [
  'domains',
  'describe',
  'show',
  'history',
  'createPlan',
  'validate',
  'probe',
  'apply',
  'verify',
  'rollback',
] as const;

type ConfigMethod = typeof CONFIG_METHODS[number];

interface LocalConfigEndpoint {
  protocolVersion: typeof LOCAL_CONFIG_PROTOCOL_VERSION;
  endpoint: string;
  token: string;
  pid: number;
  generation: string;
  startedAt: number;
}

interface LocalConfigRequest {
  protocolVersion: typeof LOCAL_CONFIG_PROTOCOL_VERSION;
  id: string;
  token: string;
  method: ConfigMethod;
  args: unknown[];
}

interface LocalConfigFault {
  code: string;
  name: string;
  message: string;
  details?: unknown;
}

type LocalConfigResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: LocalConfigFault };

export class ConfigHostUnavailableError extends Error {
  readonly code = 'CONFIG_HOST_UNAVAILABLE';

  constructor(
    message = 'The running Piskie ConfigHost is unavailable',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigHostUnavailableError';
  }
}

export class RemoteConfigHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    name = 'RemoteConfigHostError',
  ) {
    super(message);
    this.name = name;
  }
}

export interface LocalConfigServerOptions {
  rootDirectory: string;
  generation: string;
  endpointAdapter: LocalConfigEndpointAdapter;
  host: ConfigCommandPort;
}

export class LocalConfigServer {
  private readonly rootDirectory: string;
  private readonly descriptorPath: string;
  private readonly endpoint: LocalConfigEndpoint;
  private readonly sockets = new Set<Socket>();
  private server?: Server;

  constructor(private readonly options: LocalConfigServerOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.descriptorPath = localConfigDescriptorPath(this.rootDirectory);
    const instanceId = createUuid();
    this.endpoint = {
      protocolVersion: LOCAL_CONFIG_PROTOCOL_VERSION,
      endpoint: options.endpointAdapter.createEndpoint(this.rootDirectory, instanceId),
      token: randomBytes(32).toString('base64url'),
      pid: process.pid,
      generation: options.generation,
      startedAt: Date.now(),
    };
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Local Config server is already started');
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;

    try {
      await listen(server, this.endpoint.endpoint);
      await this.options.endpointAdapter.secureEndpoint(this.endpoint.endpoint);
      const runtimeDirectory = path.dirname(this.descriptorPath);
      await this.options.endpointAdapter.secureRuntimeDirectory(runtimeDirectory);
      await configFileWriter.replace(
        this.descriptorPath,
        `${JSON.stringify(this.endpoint, null, 2)}\n`,
      );
    } catch (cause) {
      await closeServer(server);
      await this.removeSocket();
      this.server = undefined;
      throw cause;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await closeServer(server);
    await Promise.all([
      this.removeDescriptor(),
      this.removeSocket(),
    ]);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    void this.serve(socket);
  }

  private async serve(socket: Socket): Promise<void> {
    let requestId = 'unknown';
    try {
      const request = decodeRequest(await readFrame(socket, REQUEST_TIMEOUT_MS));
      requestId = request.id;
      if (!tokensEqual(request.token, this.endpoint.token)) {
        throw new ConfigHostUnavailableError('The ConfigHost session is no longer available');
      }
      const data = await dispatch(this.options.host, request.method, request.args);
      writeFrame(socket, { id: request.id, ok: true, data } satisfies LocalConfigResponse);
    } catch (cause) {
      if (!socket.destroyed) {
        writeFrame(socket, {
          id: requestId,
          ok: false,
          error: serializeFault(cause),
        } satisfies LocalConfigResponse);
      }
    } finally {
      socket.end();
    }
  }

  private async removeDescriptor(): Promise<void> {
    try {
      const current = decodeEndpoint(JSON.parse(await fs.readFile(this.descriptorPath, 'utf8')));
      if (current.endpoint === this.endpoint.endpoint && current.token === this.endpoint.token) {
        await fs.unlink(this.descriptorPath);
      }
    } catch (cause) {
      if (!isNodeError(cause, 'ENOENT')) return;
    }
  }

  private async removeSocket(): Promise<void> {
    await this.options.endpointAdapter.removeEndpoint(this.endpoint.endpoint);
  }
}

export async function startLocalConfigServer(
  options: LocalConfigServerOptions,
): Promise<LocalConfigServer> {
  const server = new LocalConfigServer(options);
  await server.start();
  return server;
}

export async function connectLocalConfigHost(rootDirectory: string): Promise<ConfigCommandPort> {
  const descriptorPath = localConfigDescriptorPath(rootDirectory);
  let endpoint: LocalConfigEndpoint;
  try {
    endpoint = decodeEndpoint(JSON.parse(await fs.readFile(descriptorPath, 'utf8')));
  } catch (cause) {
    throw unavailableFrom(cause, descriptorPath);
  }
  return new LocalConfigClient(endpoint);
}

export function localConfigDescriptorPath(rootDirectory: string): string {
  return path.join(path.resolve(rootDirectory), 'runtime', 'config-host.json');
}

class LocalConfigClient implements ConfigCommandPort {
  constructor(private readonly endpoint: LocalConfigEndpoint) {}

  domains(): Promise<ConfigDomainSummary[]> {
    return this.request('domains', []);
  }

  describe(domain: string): Promise<ConfigDescriptor> {
    return this.request('describe', [domain]);
  }

  show<T = unknown>(domain: string): Promise<T> {
    return this.request('show', [domain]);
  }

  history(domain: string): Promise<readonly number[]> {
    return this.request('history', [domain]);
  }

  createPlan<T extends ConfigPlanIdentity = ConfigPlanIdentity>(
    domain: string,
    request: ConfigPlanRequest,
  ): Promise<T> {
    return this.request('createPlan', [domain, request]);
  }

  validate<T = unknown>(planId: string): Promise<T> {
    return this.request('validate', [planId]);
  }

  probe<T = unknown>(planId: string, input: ConfigProbeRequest): Promise<T> {
    return this.request('probe', [planId, input]);
  }

  apply<T extends ConfigApplyReceipt = ConfigApplyReceipt>(
    planId: string,
    expectedRevision: number,
  ): Promise<T> {
    return this.request('apply', [planId, expectedRevision]);
  }

  verify<T = unknown>(domain: string, expectedRevision?: number): Promise<T> {
    return this.request('verify', expectedRevision === undefined
      ? [domain]
      : [domain, expectedRevision]);
  }

  rollback<T extends ConfigApplyReceipt = ConfigApplyReceipt>(
    domain: string,
    targetRevision: number,
  ): Promise<T> {
    return this.request('rollback', [domain, targetRevision]);
  }

  private async request<T>(method: ConfigMethod, args: unknown[]): Promise<T> {
    const request: LocalConfigRequest = {
      protocolVersion: LOCAL_CONFIG_PROTOCOL_VERSION,
      id: createUuid(),
      token: this.endpoint.token,
      method,
      args,
    };
    let socket: Socket | undefined;
    try {
      socket = await connectSocket(this.endpoint.endpoint);
      writeFrame(socket, request);
      const response = decodeResponse(await readFrame(socket, REQUEST_TIMEOUT_MS));
      if (response.id !== request.id) throw new Error('ConfigHost response ID does not match');
      if (response.ok) return response.data as T;
      throw new RemoteConfigHostError(
        response.error.code,
        response.error.message,
        response.error.details,
        response.error.name,
      );
    } catch (cause) {
      if (cause instanceof RemoteConfigHostError) throw cause;
      throw unavailableFrom(cause, this.endpoint.endpoint);
    } finally {
      socket?.destroy();
    }
  }
}

async function dispatch(
  host: ConfigCommandPort,
  method: ConfigMethod,
  args: unknown[],
): Promise<unknown> {
  switch (method) {
    case 'domains':
      requireArity(args, 0);
      return host.domains();
    case 'describe':
      requireArity(args, 1);
      return host.describe(requireString(args[0], 'domain'));
    case 'show':
      requireArity(args, 1);
      return host.show(requireString(args[0], 'domain'));
    case 'history':
      requireArity(args, 1);
      return host.history(requireString(args[0], 'domain'));
    case 'createPlan':
      requireArity(args, 2);
      return host.createPlan(
        requireString(args[0], 'domain'),
        requireRecord(args[1], 'plan request') as unknown as ConfigPlanRequest,
      );
    case 'validate':
      requireArity(args, 1);
      return host.validate(requireString(args[0], 'plan ID'));
    case 'probe':
      requireArity(args, 2);
      return host.probe(
        requireString(args[0], 'plan ID'),
        requireRecord(args[1], 'probe request') as unknown as ConfigProbeRequest,
      );
    case 'apply':
      requireArity(args, 2);
      return host.apply(
        requireString(args[0], 'plan ID'),
        requireRevision(args[1], 'expected revision'),
      );
    case 'verify':
      if (args.length !== 1 && args.length !== 2) throw invalidRequest('verify arguments are invalid');
      return host.verify(
        requireString(args[0], 'domain'),
        args.length === 1 ? undefined : requireRevision(args[1], 'expected revision'),
      );
    case 'rollback':
      requireArity(args, 2);
      return host.rollback(
        requireString(args[0], 'domain'),
        requireRevision(args[1], 'target revision'),
      );
  }
}

function decodeEndpoint(value: unknown): LocalConfigEndpoint {
  const record = requireRecord(value, 'ConfigHost endpoint');
  if (record.protocolVersion !== LOCAL_CONFIG_PROTOCOL_VERSION) {
    throw new Error('Unsupported ConfigHost protocol version');
  }
  if (typeof record.endpoint !== 'string' || !record.endpoint) {
    throw new Error('ConfigHost endpoint is invalid');
  }
  if (typeof record.token !== 'string' || record.token.length < 32) {
    throw new Error('ConfigHost token is invalid');
  }
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
    throw new Error('ConfigHost PID is invalid');
  }
  if (typeof record.generation !== 'string' || !record.generation) {
    throw new Error('ConfigHost generation is invalid');
  }
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) {
    throw new Error('ConfigHost start time is invalid');
  }
  return {
    protocolVersion: LOCAL_CONFIG_PROTOCOL_VERSION,
    endpoint: record.endpoint,
    token: record.token,
    pid: record.pid as number,
    generation: record.generation,
    startedAt: record.startedAt,
  };
}

function decodeRequest(value: string): LocalConfigRequest {
  const record = requireRecord(JSON.parse(value), 'ConfigHost request');
  if (record.protocolVersion !== LOCAL_CONFIG_PROTOCOL_VERSION) {
    throw invalidRequest('Unsupported ConfigHost protocol version');
  }
  if (typeof record.id !== 'string' || !record.id || record.id.length > 128) {
    throw invalidRequest('ConfigHost request ID is invalid');
  }
  if (typeof record.token !== 'string') throw invalidRequest('ConfigHost token is invalid');
  if (typeof record.method !== 'string' || !isConfigMethod(record.method)) {
    throw invalidRequest('ConfigHost method is invalid');
  }
  if (!Array.isArray(record.args)) throw invalidRequest('ConfigHost arguments are invalid');
  return {
    protocolVersion: LOCAL_CONFIG_PROTOCOL_VERSION,
    id: record.id,
    token: record.token,
    method: record.method,
    args: record.args,
  };
}

function decodeResponse(value: string): LocalConfigResponse {
  const record = requireRecord(JSON.parse(value), 'ConfigHost response');
  if (typeof record.id !== 'string' || typeof record.ok !== 'boolean') {
    throw new Error('ConfigHost response is invalid');
  }
  if (record.ok) return { id: record.id, ok: true, data: record.data };
  const error = requireRecord(record.error, 'ConfigHost response error');
  if (
    typeof error.code !== 'string'
    || typeof error.name !== 'string'
    || typeof error.message !== 'string'
  ) {
    throw new Error('ConfigHost response error is invalid');
  }
  return {
    id: record.id,
    ok: false,
    error: {
      code: error.code,
      name: error.name,
      message: error.message,
      ...(error.details !== undefined && { details: error.details }),
    },
  };
}

function serializeFault(cause: unknown): LocalConfigFault {
  if (!(cause instanceof Error)) {
    return { code: 'UNEXPECTED_ERROR', name: 'Error', message: String(cause).slice(0, 512) };
  }
  const record = cause as Error & { code?: unknown; details?: unknown };
  return {
    code: typeof record.code === 'string' ? record.code : 'UNEXPECTED_ERROR',
    name: cause.name,
    message: cause.message.slice(0, 512),
    ...(record.details !== undefined && { details: record.details }),
  };
}

function writeFrame(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`, 'utf8');
}

function readFrame(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => finish(new Error('ConfigHost request timed out')), timeoutMs);

    const finish = (error?: Error, value?: string): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a);
      const frameChunk = newline < 0 ? chunk : chunk.subarray(0, newline);
      bytes += frameChunk.length;
      if (bytes > MAX_FRAME_BYTES) {
        finish(new Error('ConfigHost frame is too large'));
        return;
      }
      chunks.push(frameChunk);
      if (newline >= 0) finish(undefined, Buffer.concat(chunks, bytes).toString('utf8'));
    };
    const onError = (error: Error): void => finish(error);
    const onEnd = (): void => finish(new Error('ConfigHost connection closed before a response'));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path: endpoint, readableAll: false, writableAll: false });
  });
}

function connectSocket(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('ConfigHost connection timed out'));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
    const onError = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', onError);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}

function unavailableFrom(cause: unknown, target: string): ConfigHostUnavailableError {
  if (cause instanceof ConfigHostUnavailableError) return cause;
  return new ConfigHostUnavailableError(
    'The running Piskie ConfigHost is unavailable',
    { target },
    { cause },
  );
}

function invalidRequest(message: string): RemoteConfigHostError {
  return new RemoteConfigHostError('CONFIG_REQUEST_INVALID', message);
}

function requireArity(args: unknown[], expected: number): void {
  if (args.length !== expected) throw invalidRequest('ConfigHost argument count is invalid');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw invalidRequest(`${label} is invalid`);
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw invalidRequest(`${label} is invalid`);
  return value as number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function isConfigMethod(value: string): value is ConfigMethod {
  return (CONFIG_METHODS as readonly string[]).includes(value);
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
