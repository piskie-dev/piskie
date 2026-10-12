import { expect, it, vi } from 'vitest';
import type { StreamServerMessage } from '@shared/types/stream.js';
import type { ViewerSink } from '../../piskiepilot/browser/screen-hub.js';

const mocks = vi.hoisted(() => ({
  addViewer: vi.fn(), removeViewer: vi.fn(), updateViewerFps: vi.fn(), updateViewerQuality: vi.fn(), dispatchInput: vi.fn(),
  ports: [] as Array<{ sent: unknown[]; emit(type: string, data: unknown): boolean }>,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Port extends EventEmitter {
    readonly sent: unknown[] = [];
    postMessage(message: unknown) { this.sent.push(message); }
    start() {}
    close() {}
  }
  return { MessageChannelMain: class {
    readonly port1 = new Port(); readonly port2 = new Port();
    constructor() { mocks.ports.push(this.port1, this.port2); }
  } };
});
vi.mock('../../piskiepilot/browser/screen-hub.js', () => ({ screenStreamHub: mocks }));
import { ScreenStreamService } from '../screen-stream.service.js';

it('multiplexes page/pointer state immediately through the same port while frames retain one-in-flight backpressure', async () => {
  mocks.ports.length = 0;
  let sink!: ViewerSink;
  mocks.addViewer.mockImplementation(async (_browserId: string, viewer: ViewerSink) => { sink = viewer; });
  const service = new ScreenStreamService();
  service.start();
  await service.open({ requestId: 'sample-request', browserId: 'sample-browser' });
  const port = mocks.ports[0]!;
  const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
  const frame = (seq: number): StreamServerMessage => ({ type: 'frame', data: new Uint8Array([seq]),
    meta: { browserId: 'sample-browser', seq, page, width: 800, height: 600, timestamp: seq } });
  const state: StreamServerMessage = { type: 'screen-state', browserId: 'sample-browser', page,
    pointer: { page, seq: 1, action: 'down', x: 20, y: 30, buttons: 1, clickCount: 1, timestamp: 1 } };
  sink.send(frame(1));
  sink.send(frame(2));
  sink.send(state);
  sink.send(frame(3));
  const next = { ...page, navigationSequence: 1 };
  sink.send({ type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null });
  expect(port.sent).toEqual([frame(1), state, { type: 'screen-state', browserId: 'sample-browser', page: next, pointer: null }]);
  port.emit('message', { data: { type: 'ack' } });
  expect(port.sent.at(-1)).toEqual(frame(3));
  service.stop();
  expect(mocks.removeViewer).toHaveBeenCalledWith('sample-browser', sink);
});
