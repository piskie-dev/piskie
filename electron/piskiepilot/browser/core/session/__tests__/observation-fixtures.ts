import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ObservationFileOptions } from '../observation-files.js';
import { vi } from 'vitest';
import type { CDPSession, ConsoleMessage, Frame, HTTPRequest, HTTPResponse, Page, Protocol, ResourceType } from 'puppeteer-core';

export async function fileFixture(): Promise<{ root: string; files: ObservationFileOptions }> {
  const base = process.env.PISKIE_TEST_TEMP_DIR ?? tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'browser-data-fixture-'));
  return { root, files: { cwd: root, tempDir: path.join(root, 'temporary'), allowedRoots: [root] } };
}

export function fakePage() {
  const events = new EventEmitter();
  const client = Object.assign(new EventEmitter(), { target: () => ({ _targetId: 'fixture-target' }) });
  let mainFrame = new EventEmitter() as unknown as Frame;
  const page = Object.assign(events, {
    mainFrame: vi.fn(() => mainFrame),
    _client: () => client as unknown as CDPSession,
    createCDPSession: vi.fn(async () => { throw new Error('fixture secondary session unavailable'); }),
    hasDevTools: vi.fn(async () => false),
    openDevTools: vi.fn(),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }) as unknown as Page;
  return { page, client, get mainFrame() { return mainFrame; },
    setMainFrame(frame: Frame) { mainFrame = frame; } };
}

export function consoleMessage(text: string, options: {
  type?: string; args?: readonly unknown[]; rawStack?: Protocol.Runtime.StackTrace;
} = {}): ConsoleMessage {
  return {
    type: () => options.type ?? 'log', text: () => text,
    args: () => (options.args ?? []).map(value => ({
      remoteObject: () => ({ type: typeof value }), jsonValue: async () => value,
    })),
    _rawStackTrace: () => options.rawStack,
    _targetId: () => 'fixture-target',
  } as unknown as ConsoleMessage;
}

export function request(options: {
  url?: string; frame?: Frame; navigation?: boolean; id?: string; method?: string;
  type?: ResourceType; headers?: Record<string, string>; body?: string;
  response?: HTTPResponse | null; failure?: string; redirectChain?: readonly HTTPRequest[];
} = {}): HTTPRequest {
  return {
    id: options.id ?? 'fixture-request', url: () => options.url ?? 'https://fixture.test/data',
    frame: () => options.frame ?? null, isNavigationRequest: () => options.navigation ?? false,
    method: () => options.method ?? 'GET', resourceType: () => options.type ?? 'fetch',
    headers: () => options.headers ?? {}, hasPostData: () => options.body !== undefined,
    postData: () => options.body, fetchPostData: vi.fn(async () => options.body),
    response: () => options.response ?? null,
    failure: () => options.failure ? { errorText: options.failure } : null,
    redirectChain: () => [...options.redirectChain ?? []],
  } as unknown as HTTPRequest;
}

export function response(body: string | Uint8Array, status = 200): HTTPResponse {
  return { buffer: vi.fn(async () => Buffer.from(body)), status: () => status,
    headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'fixture=value' }),
  } as unknown as HTTPResponse;
}
