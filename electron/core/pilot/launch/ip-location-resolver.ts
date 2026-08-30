import https from 'node:https';
import { createProxyAgent } from '../../proxy/proxy-agent-factory.js';
import type { EffectiveNetworkRoute, IpLocationSnapshot } from './browser-launch-types.js';

const DEFAULT_DEADLINE_MS = 12_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_ENDPOINTS = Object.freeze([
  'https://ipwho.is/',
  'https://api.ip.sb/geoip',
  'https://ipinfo.io/json',
]);

export class IpLocationResolver {
  private readonly endpoints: readonly string[];

  constructor(endpoints: string | readonly string[] = DEFAULT_ENDPOINTS) {
    this.endpoints = typeof endpoints === 'string' ? [endpoints] : [...endpoints];
    if (this.endpoints.length === 0) {
      throw new TypeError('IP location resolver requires at least one endpoint');
    }
  }

  async resolve(
    route: EffectiveNetworkRoute,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<IpLocationSnapshot> {
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new TypeError('IP location deadline must be positive');
    }

    const startedAt = Date.now();
    const failures: Error[] = [];
    for (const [index, endpoint] of this.endpoints.entries()) {
      if (options.signal?.aborted) throw new Error('IP location request was aborted');

      const remainingMs = deadlineMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        failures.push(new Error(`IP location resolution timed out after ${deadlineMs}ms`));
        break;
      }
      const attemptsLeft = this.endpoints.length - index;
      const attemptDeadlineMs = Math.max(1, Math.floor(remainingMs / attemptsLeft));

      try {
        return await this.requestEndpoint(endpoint, route, options.signal, attemptDeadlineMs);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (options.signal?.aborted) throw failure;
        failures.push(new Error(
          `IP location provider ${endpoint} failed: ${failure.message}`,
          { cause: failure },
        ));
      }
    }

    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      `IP location resolution failed after trying ${this.endpoints.length} providers`,
    );
  }

  private requestEndpoint(
    endpoint: string,
    route: EffectiveNetworkRoute,
    signal: AbortSignal | undefined,
    deadlineMs: number,
  ): Promise<IpLocationSnapshot> {
    return new Promise<IpLocationSnapshot>((resolve, reject) => {
      let settled = false;
      function abort(): void {
        request.destroy();
        finish(new Error('IP location request was aborted'));
      }
      function finish(error?: Error, snapshot?: IpLocationSnapshot): void {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(snapshot!);
      }
      function timeout(): void {
        request.destroy();
        finish(new Error(`IP location request timed out after ${deadlineMs}ms`));
      }

      const request = https.get(endpoint, {
        ...(route.kind === 'proxy' ? { agent: createProxyAgent(route.profile) } : {}),
      }, (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          finish(new Error(`IP location request failed with HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            finish(new Error('IP location response exceeded the size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            finish(undefined, parseLocation(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on('error', (error) => finish(error));
      });
      request.on('error', (error) => finish(error));
      const deadlineTimer = setTimeout(timeout, deadlineMs);
      deadlineTimer.unref?.();
      request.setTimeout(deadlineMs, timeout);

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

function parseLocation(value: unknown): IpLocationSnapshot {
  if (!isRecord(value) || value.success === false || typeof value.ip !== 'string' || !value.ip) {
    throw new Error('IP location response is invalid');
  }
  const timezone = isRecord(value.timezone) && typeof value.timezone.id === 'string'
    ? value.timezone.id
    : typeof value.timezone === 'string'
      ? value.timezone
      : undefined;
  const countryCode = typeof value.country_code === 'string'
    ? value.country_code
    : typeof value.country === 'string' && value.country.length === 2
      ? value.country
      : undefined;
  const [locLatitude, locLongitude] = parseCoordinatePair(value.loc);
  const latitude = parseCoordinate(value.latitude, -90, 90) ?? locLatitude;
  const longitude = parseCoordinate(value.longitude, -180, 180) ?? locLongitude;
  return {
    ...(countryCode ? { countryCode } : {}),
    ...(timezone ? { timezone } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
  };
}

function parseCoordinatePair(value: unknown): [number | undefined, number | undefined] {
  if (typeof value !== 'string') return [undefined, undefined];
  const parts = value.split(',');
  if (parts.length !== 2) return [undefined, undefined];
  return [
    parseCoordinate(parts[0], -90, 90),
    parseCoordinate(parts[1], -180, 180),
  ];
}

function parseCoordinate(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
