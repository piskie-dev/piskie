/** 微信 vendor logger 转发到 Piskie 应用日志，不再写 OpenClaw 临时目录下的日志文件。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child, childFactory: vi.fn(() => child) };
});

vi.mock('@electron/observability/logging/app-log.js', () => ({
  appLog: { child: spies.childFactory },
}));

import { logger, setLogLevel } from '../vendor/src/util/logger.js';

beforeEach(() => {
  spies.child.debug.mockClear();
  spies.child.info.mockClear();
  spies.child.warn.mockClear();
  spies.child.error.mockClear();
  setLogLevel('INFO');
});

describe('weixin vendor logger → appLog', () => {
  it('forwards info/warn/error as static records with the vendor text in context', () => {
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');
    expect(spies.childFactory).toHaveBeenCalledWith({ scope: 'messaging.vendor' });
    expect(spies.child.info).toHaveBeenCalledWith({
      event: 'messaging.vendor.line.info',
      message: 'Vendor info line',
      context: { channel: 'openclaw-weixin', text: 'hello', logger: 'gateway/channels/openclaw-weixin' },
    });
    expect(spies.child.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'messaging.vendor.line.warn',
      context: expect.objectContaining({ text: 'careful' }),
    }));
    expect(spies.child.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'messaging.vendor.line.error',
      context: expect.objectContaining({ text: 'boom' }),
    }));
  });

  it('filters below the configured level and honours setLogLevel', () => {
    logger.debug('hidden');
    expect(spies.child.debug).not.toHaveBeenCalled();
    setLogLevel('DEBUG');
    logger.debug('shown');
    expect(spies.child.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'messaging.vendor.line.debug',
      context: expect.objectContaining({ text: 'shown' }),
    }));
    expect(() => setLogLevel('LOUD')).toThrow(/Invalid log level/);
  });

  it('withAccount prefixes the message and adds accountId context; no log file path is exposed', () => {
    const scoped = logger.withAccount('acct-1');
    scoped.info('bound');
    expect(spies.child.info).toHaveBeenCalledWith({
      event: 'messaging.vendor.line.info',
      message: 'Vendor info line',
      context: {
        channel: 'openclaw-weixin',
        text: '[acct-1] bound',
        logger: 'gateway/channels/openclaw-weixin/acct-1',
        accountId: 'acct-1',
      },
    });
    expect((logger as unknown as { getLogFilePath?: unknown }).getLogFilePath).toBeUndefined();
    expect(() => logger.close()).not.toThrow();
  });
});
