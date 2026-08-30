import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    listeners,
    ipcMain: {
      on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
        const entries = listeners.get(channel) ?? new Set();
        entries.add(listener);
        listeners.set(channel, entries);
      }),
      removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
        listeners.get(channel)?.delete(listener);
      }),
    },
  };
});

vi.mock('electron', () => ({ ipcMain: electron.ipcMain }));

import { createControllerCatalog } from '../../../capabilities/catalog.js';
import { ElectronPortServer } from '../bootstrap-listener.js';
import { PortRouter } from '../port-router.js';
import { ELECTRON_CONNECT_CHANNEL } from '../../../../shared/electron-contracts/protocol.js';

class FakePort {
  readonly sent: unknown[] = [];
  readonly close = vi.fn();
  readonly start = vi.fn();
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

beforeEach(() => {
  electron.listeners.clear();
  vi.clearAllMocks();
});

function serverFixture(authorize = vi.fn(() => ({
  windowId: 7,
  attach: vi.fn(),
  detached: vi.fn(),
}))) {
  const catalog = createControllerCatalog({
    operations: [{
      id: 'runtime.echo',
      capability: 'runtime',
      input: z.tuple([]),
      execute: () => 'ok',
    }],
  });
  const router = new PortRouter(catalog, { phase: () => 'ready' });
  const server = new ElectronPortServer({
    generation: 'generation-test',
    router,
    runtimeSnapshot: () => ({ phase: 'ready', startedAt: 1, degraded: [] }),
    authorize,
  });
  return { server, authorize };
}

function connect(port: FakePort, rawHello: unknown = {
  protocolVersion: 1,
  rendererBuildId: '0.1.0',
  windowNonce: 'nonce-one',
}): void {
  const frame = { url: 'http://localhost:5174/' };
  const event = {
    ports: [port],
    senderFrame: frame,
    sender: { id: 100, mainFrame: frame },
  };
  for (const listener of electron.listeners.get(ELECTRON_CONNECT_CHANNEL) ?? []) {
    listener(event, rawHello);
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('ElectronPortServer', () => {
  it('registers the bootstrap listener once across multiple window connections', async () => {
    const { server, authorize } = serverFixture();
    server.start();
    expect(() => server.start()).toThrow('already listening');
    expect(electron.ipcMain.on).toHaveBeenCalledOnce();

    const first = new FakePort();
    const second = new FakePort();
    connect(first);
    connect(second, {
      protocolVersion: 1,
      rendererBuildId: '0.1.0',
      windowNonce: 'nonce-two',
    });

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(server.snapshot()).toEqual({ listening: true, connectionCount: 2 });
    expect(first.sent[0]).toMatchObject({ kind: 'welcome' });
    expect(second.sent[0]).toMatchObject({ kind: 'welcome' });
    expect(electron.ipcMain.on).toHaveBeenCalledOnce();

    first.emit('close');
    await settle();
    expect(server.snapshot().connectionCount).toBe(1);
    await server.stop();
    await server.stop();
    expect(electron.ipcMain.removeListener).toHaveBeenCalledOnce();
    expect(server.snapshot()).toEqual({ listening: false, connectionCount: 0 });
  });

  it('closes rejected, malformed and multi-port handshakes without a connection', () => {
    const rejected = vi.fn(() => undefined);
    const { server } = serverFixture(rejected);
    server.start();

    const unauthorized = new FakePort();
    connect(unauthorized);
    expect(unauthorized.sent[0]).toEqual({ kind: 'closed', reason: 'connection-rejected' });
    expect(unauthorized.close).toHaveBeenCalledOnce();

    const malformed = new FakePort();
    connect(malformed, { protocolVersion: 99 });
    expect(malformed.sent[0]).toEqual({ kind: 'closed', reason: 'invalid-handshake' });
    expect(malformed.close).toHaveBeenCalledOnce();
    expect(server.snapshot().connectionCount).toBe(0);
  });
});
