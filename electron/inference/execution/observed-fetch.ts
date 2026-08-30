export interface ObservedHttpFailure {
  kind: 'http';
  status: number;
  statusText: string;
  requestId?: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}

export interface ObservedTransportFailure {
  kind: 'transport';
  name?: string;
  message: string;
  code?: string;
  cause?: unknown;
}

export type FetchFailureObservation = ObservedHttpFailure | ObservedTransportFailure;

export interface AttemptFetchObserver {
  fetch: typeof globalThis.fetch;
  failure(): FetchFailureObservation | undefined;
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 2_000;
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'cf-ray'] as const;

export function createAttemptFetchObserver(
  upstreamFetch: typeof globalThis.fetch = globalThis.fetch,
): AttemptFetchObserver {
  let observedFailure: FetchFailureObservation | undefined;

  return {
    fetch: async (input, init) => {
      try {
        const response = await upstreamFetch(input, init);
        if (!response.ok) observedFailure = await observeHttpFailure(response);
        return response;
      } catch (cause) {
        observedFailure = observeTransportFailure(cause);
        throw cause;
      }
    },
    failure: () => observedFailure,
  };
}

async function observeHttpFailure(response: Response): Promise<ObservedHttpFailure> {
  const headers = Object.fromEntries(response.headers.entries());
  return {
    kind: 'http',
    status: response.status,
    statusText: response.statusText,
    headers,
    requestId: firstHeader(response.headers, REQUEST_ID_HEADERS),
    body: await readErrorBody(response.clone()),
  };
}

function observeTransportFailure(cause: unknown): ObservedTransportFailure {
  const error = cause as { name?: unknown; message?: unknown; code?: unknown } | undefined;
  return {
    kind: 'transport',
    ...(typeof error?.name === 'string' && { name: error.name }),
    message: typeof error?.message === 'string' ? error.message : String(cause),
    ...(typeof error?.code === 'string' && { code: error.code }),
    cause,
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const bytes = await Promise.race([
      readLimitedBytes(response, MAX_ERROR_BODY_BYTES),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), ERROR_BODY_TIMEOUT_MS);
      }),
    ]);
    if (!bytes) return undefined;
    const text = new TextDecoder().decode(bytes);
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readLimitedBytes(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limit ? bytes.slice(0, limit) : bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - total;
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (next.value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total === 0) return undefined;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function firstHeader(headers: Headers, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

