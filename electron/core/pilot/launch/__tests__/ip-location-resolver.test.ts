import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('node:https', () => ({
  default: { get: network.get },
  get: network.get,
}));

import { IpLocationResolver } from '../ip-location-resolver.js';

interface FakeRequest extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
}

function fakeRequest(): FakeRequest {
  const request = new EventEmitter() as FakeRequest;
  request.destroy = vi.fn();
  request.setTimeout = vi.fn();
  return request;
}

function respond(request: FakeRequest, payload: string, statusCode = 200): void {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    resume: ReturnType<typeof vi.fn>;
  };
  response.statusCode = statusCode;
  response.resume = vi.fn();
  const callback = network.get.mock.calls.at(-1)?.[2] as ((value: typeof response) => void);
  queueMicrotask(() => {
    callback(response);
    response.emit('data', Buffer.from(payload));
    response.emit('end');
  });
  void request;
}

beforeEach(() => network.get.mockReset());

describe('IpLocationResolver', () => {
  it('validates and maps a bounded direct response', async () => {
    const request = fakeRequest();
    network.get.mockImplementation((..._args: unknown[]) => request);
    const resolver = new IpLocationResolver('https://location.test/');
    const resolving = resolver.resolve({ kind: 'direct' });
    respond(request, JSON.stringify({
      success: true,
      ip: '203.0.113.10',
      country_code: 'CN',
      timezone: { id: 'Asia/Shanghai' },
      latitude: 31.23,
      longitude: 121.47,
    }));

    await expect(resolving).resolves.toEqual({
      countryCode: 'CN',
      timezone: 'Asia/Shanghai',
      latitude: 31.23,
      longitude: 121.47,
    });
    expect(network.get.mock.calls[0]?.[1]).not.toHaveProperty('agent');
  });

  it('uses the selected proxy only as the lookup request transport', async () => {
    const request = fakeRequest();
    network.get.mockImplementation((..._args: unknown[]) => request);
    const resolving = new IpLocationResolver('https://location.test/').resolve({
      kind: 'proxy',
      profile: {
        id: 'proxy-a',
        name: 'Proxy A',
        protocol: 'http',
        host: '127.0.0.1',
        port: 8080,
        enabled: true,
      },
    });
    respond(request, JSON.stringify({ success: true, ip: '203.0.113.11' }));

    await expect(resolving).resolves.toEqual({});
    expect(network.get.mock.calls[0]?.[1]).toHaveProperty('agent');
  });

  it('aborts the request and rejects without publishing a partial snapshot', async () => {
    const request = fakeRequest();
    network.get.mockImplementation((..._args: unknown[]) => request);
    const controller = new AbortController();
    const resolving = new IpLocationResolver('https://location.test/').resolve(
      { kind: 'direct' },
      { signal: controller.signal },
    );

    controller.abort();

    await expect(resolving).rejects.toThrow('aborted');
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it('enforces the deadline, response-size limit and JSON shape', async () => {
    const timeoutRequest = fakeRequest();
    network.get.mockImplementationOnce((..._args: unknown[]) => timeoutRequest);
    const timedOut = new IpLocationResolver('https://location.test/').resolve(
      { kind: 'direct' },
      { deadlineMs: 25 },
    );
    const timeout = timeoutRequest.setTimeout.mock.calls[0]?.[1] as (() => void);
    timeout();
    await expect(timedOut).rejects.toThrow('timed out after 25ms');

    const largeRequest = fakeRequest();
    network.get.mockImplementationOnce((..._args: unknown[]) => largeRequest);
    const oversized = new IpLocationResolver('https://location.test/').resolve({ kind: 'direct' });
    respond(largeRequest, 'x'.repeat(256 * 1024 + 1));
    await expect(oversized).rejects.toThrow('size limit');

    const invalidRequest = fakeRequest();
    network.get.mockImplementationOnce((..._args: unknown[]) => invalidRequest);
    const invalid = new IpLocationResolver('https://location.test/').resolve({ kind: 'direct' });
    respond(invalidRequest, JSON.stringify({ success: true, country_code: 'CN' }));
    await expect(invalid).rejects.toThrow('invalid');
  });

  it('falls back from ipwho.is to api.ip.sb', async () => {
    const primaryRequest = fakeRequest();
    const fallbackRequest = fakeRequest();
    network.get
      .mockImplementationOnce((..._args: unknown[]) => primaryRequest)
      .mockImplementationOnce((..._args: unknown[]) => fallbackRequest);
    const resolving = new IpLocationResolver([
      'https://ipwho.is/',
      'https://api.ip.sb/geoip',
      'https://ipinfo.io/json',
    ]).resolve({ kind: 'direct' });

    primaryRequest.emit('error', new Error('primary unavailable'));
    await vi.waitFor(() => expect(network.get).toHaveBeenCalledTimes(2));
    respond(fallbackRequest, JSON.stringify({
      ip: '203.0.113.12',
      country_code: 'CN',
      timezone: 'Asia/Shanghai',
      latitude: 31.23,
      longitude: 121.47,
    }));

    await expect(resolving).resolves.toEqual({
      countryCode: 'CN',
      timezone: 'Asia/Shanghai',
      latitude: 31.23,
      longitude: 121.47,
    });
    expect(network.get.mock.calls.map((call) => call[0])).toEqual([
      'https://ipwho.is/',
      'https://api.ip.sb/geoip',
    ]);
  });

  it('falls back to ipinfo.io and maps its country and loc fields', async () => {
    const primaryRequest = fakeRequest();
    const secondaryRequest = fakeRequest();
    const finalRequest = fakeRequest();
    network.get
      .mockImplementationOnce((..._args: unknown[]) => primaryRequest)
      .mockImplementationOnce((..._args: unknown[]) => secondaryRequest)
      .mockImplementationOnce((..._args: unknown[]) => finalRequest);
    const resolving = new IpLocationResolver([
      'https://ipwho.is/',
      'https://api.ip.sb/geoip',
      'https://ipinfo.io/json',
    ]).resolve({ kind: 'direct' });

    primaryRequest.emit('error', new Error('primary unavailable'));
    await vi.waitFor(() => expect(network.get).toHaveBeenCalledTimes(2));
    respond(secondaryRequest, JSON.stringify({ error: 'rate limited' }), 429);
    await vi.waitFor(() => expect(network.get).toHaveBeenCalledTimes(3));
    respond(finalRequest, JSON.stringify({
      ip: '203.0.113.13',
      country: 'US',
      timezone: 'America/Los_Angeles',
      loc: '34.0522,-118.2437',
    }));

    await expect(resolving).resolves.toEqual({
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      latitude: 34.0522,
      longitude: -118.2437,
    });
    expect(network.get.mock.calls.map((call) => call[0])).toEqual([
      'https://ipwho.is/',
      'https://api.ip.sb/geoip',
      'https://ipinfo.io/json',
    ]);
  });
});
