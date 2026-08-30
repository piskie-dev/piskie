import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createControllerCatalog, streamTransfer } from '../../../capabilities/catalog.js';
import { PortRouter } from '../port-router.js';
import {
  WindowConnection,
  type HostMessageEvent,
  type HostMessagePort,
} from '../window-connection.js';

class FakePort implements HostMessagePort {
  readonly sent: Array<{ message: unknown; transfer?: readonly { close(): void }[] }> = [];
  started = false;
  closed = false;
  private messageListener?: (event: HostMessageEvent) => void;
  private closeListener?: () => void;

  postMessage(message: unknown, transfer?: readonly { close(): void }[]): void {
    if (this.closed) throw new Error('closed');
    this.sent.push({ message, transfer });
  }

  on(event: 'message' | 'close', listener: ((event: HostMessageEvent) => void) | (() => void)): this {
    if (event === 'message') this.messageListener = listener as (event: HostMessageEvent) => void;
    else this.closeListener = listener as () => void;
    return this;
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  receive(data: unknown): void {
    this.messageListener?.({ data });
  }

  peerClose(): void {
    this.closeListener?.();
  }
}

function fixture(
  input: Parameters<typeof createControllerCatalog>[0],
  phase: 'ready' | 'stopping' | 'closed' = 'ready',
) {
  const port = new FakePort();
  const catalog = createControllerCatalog(input);
  const router = new PortRouter(catalog, { phase: () => phase });
  const connection = new WindowConnection(port, router, {
    generation: 'g-test',
    windowId: 7,
    welcome: {
      protocolVersion: 1,
      generation: 'g-test',
      runtime: { phase: 'ready', startedAt: 1, degraded: [] },
      capabilities: catalog.capabilities,
    },
  });
  connection.start();
  return { port, connection };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('WindowConnection', () => {
  it('sends welcome and routes a validated request', async () => {
    const execute = vi.fn(async (_context, input: [string]) => input[0].toUpperCase());
    const { port } = fixture({
      operations: [{
        id: 'agents.echo',
        capability: 'agents',
        input: z.tuple([z.string()]),
        execute,
      }],
    });

    port.receive({ kind: 'request', id: 'r1', operation: 'agents.echo', payload: ['hello'] });
    await settle();

    expect(port.sent[0].message).toMatchObject({ kind: 'welcome' });
    expect(port.sent[1].message).toEqual({ kind: 'result', id: 'r1', value: 'HELLO' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects invalid payload without entering the controller', async () => {
    const execute = vi.fn();
    const { port } = fixture({
      operations: [{
        id: 'agents.echo',
        capability: 'agents',
        input: z.tuple([z.string()]),
        execute,
      }],
    });

    port.receive({ kind: 'request', id: 'r1', operation: 'agents.echo', payload: [42] });
    await settle();

    expect(port.sent[1].message).toMatchObject({
      kind: 'fault',
      id: 'r1',
      fault: { code: 'invalid-input' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('settles cancellation even when the operation ignores AbortSignal', async () => {
    const { port, connection } = fixture({
      operations: [{
        id: 'agents.wait',
        capability: 'agents',
        input: z.tuple([]),
        execute: () => new Promise<void>(() => undefined),
      }],
    });

    port.receive({ kind: 'request', id: 'r1', operation: 'agents.wait', payload: [] });
    port.receive({ kind: 'cancel', id: 'r1' });
    await settle();

    expect(port.sent[1].message).toMatchObject({
      kind: 'fault',
      id: 'r1',
      fault: { code: 'aborted' },
    });
    expect(connection.snapshot().pendingRequests).toBe(0);
  });

  it('delivers snapshot before changes and disposes on close', async () => {
    const dispose = vi.fn();
    const { port, connection } = fixture({
      operations: [],
      topics: [{
        id: 'agents.live-content',
        capability: 'agents',
        input: z.undefined(),
        open: (_context, _input, emit) => {
          emit({ state: 'queued' });
          return { snapshot: { state: 'initial' }, dispose };
        },
      }],
    });

    port.receive({ kind: 'subscribe', id: 's1', topic: 'agents.live-content' });
    await settle();

    expect(port.sent[1].message).toMatchObject({
      kind: 'subscribed',
      id: 's1',
      snapshot: { state: 'initial' },
    });
    expect(port.sent[2].message).toMatchObject({
      kind: 'change',
      sequence: 1,
      value: { state: 'queued' },
    });
    await connection.close('test');
    expect(dispose).toHaveBeenCalledOnce();
    expect(connection.snapshot()).toMatchObject({
      closed: true,
      pendingRequests: 0,
      subscriptions: 0,
      childPorts: 0,
    });
  });

  it('transfers child stream ports and owns their cleanup', async () => {
    const child = { close: vi.fn() };
    const { port, connection } = fixture({
      operations: [{
        id: 'pilot.screen.requestStream',
        capability: 'pilot',
        input: z.tuple([]),
        execute: () => streamTransfer(child, { streamId: 'screen-1' }),
      }],
    });

    port.receive({
      kind: 'request',
      id: 'r1',
      operation: 'pilot.screen.requestStream',
      payload: [],
    });
    await settle();

    expect(port.sent[1]).toMatchObject({
      message: { kind: 'stream', id: 'r1', metadata: { streamId: 'screen-1' } },
      transfer: [child],
    });
    await connection.close('test');
    expect(child.close).toHaveBeenCalledOnce();
  });

  it('closes the connection on malformed frames', async () => {
    const { port, connection } = fixture({ operations: [] });
    port.receive({ kind: 'request', id: '../bad', operation: 'x', payload: null });
    await settle();
    expect(connection.snapshot().closed).toBe(true);
  });

  it('returns stable faults for unknown operations and topics', async () => {
    const { port } = fixture({ operations: [], topics: [] });

    port.receive({ kind: 'request', id: 'r1', operation: 'agents.missing', payload: [] });
    port.receive({ kind: 'subscribe', id: 's1', topic: 'agents.missing' });
    await settle();

    expect(port.sent.map(({ message }) => message)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'fault',
        id: 'r1',
        fault: expect.objectContaining({ code: 'unsupported' }),
      }),
      expect.objectContaining({
        kind: 'fault',
        id: 's1',
        fault: expect.objectContaining({ code: 'unsupported' }),
      }),
    ]));
  });

  it('rejects commands at the stopping gate without entering the controller', async () => {
    const execute = vi.fn();
    const { port } = fixture({
      operations: [{
        id: 'agents.mutate',
        capability: 'agents',
        input: z.tuple([]),
        execute,
      }],
    }, 'stopping');

    port.receive({ kind: 'request', id: 'r1', operation: 'agents.mutate', payload: [] });
    await settle();

    expect(port.sent[1].message).toMatchObject({
      kind: 'fault',
      fault: { code: 'not-ready' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an already-expired deadline before entering the use case', async () => {
    const execute = vi.fn();
    const { port } = fixture({
      operations: [{
        id: 'agents.mutate',
        capability: 'agents',
        input: z.tuple([]),
        execute,
      }],
    });

    port.receive({
      kind: 'request',
      id: 'r1',
      operation: 'agents.mutate',
      payload: [],
      deadlineAt: Date.now() - 1,
    });
    await settle();

    expect(port.sent[1].message).toMatchObject({
      kind: 'fault',
      fault: { code: 'deadline-exceeded' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits one deadline fault and ignores a late controller result', async () => {
    let resolve!: (value: string) => void;
    const { port, connection } = fixture({
      operations: [{
        id: 'agents.wait',
        capability: 'agents',
        input: z.tuple([]),
        execute: () => new Promise<string>((done) => { resolve = done; }),
      }],
    });

    port.receive({
      kind: 'request',
      id: 'r1',
      operation: 'agents.wait',
      payload: [],
      deadlineAt: Date.now() + 2,
    });
    await new Promise<void>((done) => setTimeout(done, 10));
    resolve('too-late');
    await settle();

    const responses = port.sent
      .map(({ message }) => message as { id?: string; kind?: string })
      .filter(({ id }) => id === 'r1');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ kind: 'fault' });
    expect(connection.snapshot().pendingRequests).toBe(0);
  });

  it('continues closing child ports when one child close throws', async () => {
    const first = { close: vi.fn(() => { throw new Error('already invalid'); }) };
    const second = { close: vi.fn() };
    let next = first;
    const { port, connection } = fixture({
      operations: [{
        id: 'pilot.screen.requestStream',
        capability: 'pilot',
        input: z.tuple([]),
        execute: () => {
          const selected = next;
          next = second;
          return streamTransfer(selected);
        },
      }],
    });
    port.receive({
      kind: 'request',
      id: 'r1',
      operation: 'pilot.screen.requestStream',
      payload: [],
    });
    port.receive({
      kind: 'request',
      id: 'r2',
      operation: 'pilot.screen.requestStream',
      payload: [],
    });
    await settle();

    await connection.close('test');
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(connection.snapshot().childPorts).toBe(0);
  });
});
