import { describe, expect, it } from 'vitest';
import {
  createAppLog,
  createAppLogController,
  MemoryLogSink,
} from '../app-log.js';

describe('AppLog', () => {
  it('writes structured child context to an injected sink', () => {
    const sink = new MemoryLogSink();
    const log = createAppLog({ sink, origin: 'cli' }).child({ scope: 'config.cli', operationId: 'op-1' });

    log.info({
      event: 'config.cli.load.completed',
      message: 'Configuration loaded',
      context: { domain: 'agent-runs' },
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      event: 'config.cli.load.completed',
      scope: 'config.cli',
      origin: 'cli',
      context: { operationId: 'op-1', domain: 'agent-runs' },
    });
  });

  it('flushes early events in order when the sink is installed', () => {
    const controller = createAppLogController({ origin: 'main' });
    controller.log.info({
      event: 'desktop.runtime.start.started',
      message: 'Desktop runtime startup started',
    });
    controller.log.info({
      event: 'desktop.runtime.start.completed',
      message: 'Desktop runtime started',
    });
    const sink = new MemoryLogSink();

    controller.install(sink);

    expect(sink.events.map((event) => event.event)).toEqual([
      'desktop.runtime.start.started',
      'desktop.runtime.start.completed',
    ]);
  });
});
