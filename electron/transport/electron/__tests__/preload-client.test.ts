import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: { postMessage: electron.postMessage },
}));

import { ElectronPreloadClient } from '../preload-client.js';
import { createElectronPiskieClient } from '../piskie-client.js';
import { DESKTOP_TOPICS } from '../../../../shared/electron-contracts/desktop.js';

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
  electron.postMessage.mockReset();
});

async function connect(): Promise<{
  client: ElectronPreloadClient;
  host: MessagePort;
  messages: unknown[];
}> {
  const client = new ElectronPreloadClient({
    rendererBuildId: '0.1.0',
    windowNonce: 'window-test',
    connectTimeoutMs: 1_000,
  });
  const call = electron.postMessage.mock.calls.at(-1) as [string, unknown, MessagePort[]];
  const host = call[2][0]!;
  const messages: unknown[] = [];
  host.addEventListener('message', (event) => messages.push(event.data));
  host.start();
  openPorts.push(host);
  host.postMessage({
    kind: 'welcome',
    welcome: {
      protocolVersion: 1,
      generation: 'generation-test',
      connectionId: 'connection-test',
      runtime: { phase: 'ready', startedAt: 1, degraded: [] },
      capabilities: ['agents', 'modes', 'runtime'],
    },
  });
  await client.connected();
  return { client, host, messages };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function frames<T extends { kind?: string }>(messages: unknown[], kind: string): T[] {
  return messages.filter((message): message is T => (
    Boolean(message)
    && typeof message === 'object'
    && (message as { kind?: unknown }).kind === kind
  ));
}

describe('ElectronPreloadClient', () => {
  it('keeps QR login waiting beyond the regular 30-second request deadline', async () => {
    const { client: transport, host, messages } = await connect();
    const client = createElectronPiskieClient({ getPathForFile: vi.fn(), transport, version: 'test', platform: 'darwin' });
    vi.useFakeTimers();
    try {
      const result = client.messaging.waitForQrLogin('bot-1', 'openclaw-weixin');
      void result.catch(() => undefined); // 清理失败用例的未完成请求时也消费 rejection。
      await vi.waitFor(() => expect(frames(messages, 'request')).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(35_000);
      expect(frames(messages, 'cancel')).toHaveLength(0);
      const [request] = frames<{ kind: 'request'; id: string; deadlineAt?: number }>(messages, 'request');
      expect(request!.deadlineAt).toBeUndefined();
      host.postMessage({ kind: 'result', id: request!.id, value: {
        connected: true, state: 'connected', message: 'Connected',
      } });
      await expect(result).resolves.toMatchObject({ connected: true });
    } finally {
      transport.close();
      vi.useRealTimers();
    }
  });

  it('removes AbortSignal listeners after a request settles', async () => {
    const { client, host, messages } = await connect();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const result = client.request<string>('agents.echo', ['hello'], {
      timeoutMs: 0,
      signal: controller.signal,
    });
    await settle();
    const [request] = frames<{ kind: 'request'; id: string }>(messages, 'request');
    host.postMessage({ kind: 'result', id: request!.id, value: 'HELLO' });

    await expect(result).resolves.toBe('HELLO');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    await settle();
    expect(frames(messages, 'cancel')).toHaveLength(0);
    client.close();
  });

  it('unsubscribes a host subscription disposed before its acknowledgement', async () => {
    const { client, host, messages } = await connect();
    const dispose = client.subscribe('agents.state', { onChange: vi.fn() });
    await settle();
    const [subscribe] = frames<{ kind: 'subscribe'; id: string }>(messages, 'subscribe');

    dispose();
    host.postMessage({
      kind: 'subscribed',
      id: subscribe!.id,
      subscriptionId: 'subscription-one',
      snapshot: [],
      cursor: '0',
    });
    await settle();

    expect(frames(messages, 'unsubscribe')).toEqual([
      { kind: 'unsubscribe', subscriptionId: 'subscription-one' },
    ]);
    client.close();
  });

  it('reopens a subscription and delivers a fresh snapshot after a sequence gap', async () => {
    const { client, host, messages } = await connect();
    const onSnapshot = vi.fn();
    const onChange = vi.fn();
    const onError = vi.fn();
    client.subscribe('agents.state', { onSnapshot, onChange, onError });
    await settle();
    const first = frames<{ kind: 'subscribe'; id: string }>(messages, 'subscribe')[0]!;
    host.postMessage({
      kind: 'subscribed',
      id: first.id,
      subscriptionId: 'subscription-one',
      snapshot: ['initial'],
      cursor: '0',
    });
    await settle();

    host.postMessage({
      kind: 'change',
      subscriptionId: 'subscription-one',
      sequence: 2,
      value: { state: 'missed-one' },
      cursor: '2',
    });
    await settle();
    const subscriptions = frames<{ kind: 'subscribe'; id: string }>(messages, 'subscribe');
    expect(subscriptions).toHaveLength(2);
    expect(frames(messages, 'unsubscribe')).toContainEqual({
      kind: 'unsubscribe',
      subscriptionId: 'subscription-one',
    });

    host.postMessage({
      kind: 'subscribed',
      id: subscriptions[1]!.id,
      subscriptionId: 'subscription-two',
      snapshot: ['recovered'],
      cursor: '0',
    });
    await settle();

    expect(onSnapshot).toHaveBeenNthCalledWith(1, ['initial']);
    expect(onSnapshot).toHaveBeenNthCalledWith(2, ['recovered']);
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Subscription sequence gap',
    }));
    client.close();
  });

  it('notifies pending subscriptions and requests when the host closes', async () => {
    const { client, host, messages } = await connect();
    const onError = vi.fn();
    client.subscribe('agents.state', { onChange: vi.fn(), onError });
    const request = client.request('agents.wait', [], { timeoutMs: 0 });
    await settle();
    expect(frames(messages, 'subscribe')).toHaveLength(1);
    expect(frames(messages, 'request')).toHaveLength(1);

    host.postMessage({ kind: 'closed', reason: 'desktop-stop' });
    await expect(request).rejects.toThrow('desktop-stop');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('desktop-stop'),
    }));
  });

  it('delivers file snapshots, deletion changes and active subscription faults to the API observer', async () => {
    const { client: transport, host, messages } = await connect();
    const client = createElectronPiskieClient({ transport, getPathForFile: vi.fn(), version: 'test', platform: 'linux' });
    const listener = vi.fn();
    const onError = vi.fn();
    const dispose = client.desktop.files.observe('/sample/file.txt', listener, onError);
    await vi.waitFor(() => expect(frames(messages, 'subscribe')).toHaveLength(1));
    const subscribe = frames<{ kind: 'subscribe'; id: string }>(messages, 'subscribe')[0]!;
    expect(subscribe).toMatchObject({ topic: DESKTOP_TOPICS.fileChanges, payload: { path: '/sample/file.txt' } });
    host.postMessage({ kind: 'subscribed', id: subscribe.id, subscriptionId: 'sample-subscription', snapshot: 'sample-token', cursor: '0' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledExactlyOnceWith('sample-token'));
    host.postMessage({ kind: 'change', subscriptionId: 'sample-subscription', sequence: 1, value: null, cursor: '1' });
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(null));
    host.postMessage({ kind: 'fault', id: 'sample-subscription', fault: {
      code: 'unavailable', message: 'Sample watch unavailable', correlationId: 'sample-fault', retryable: false,
    } });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unavailable', message: 'Sample watch unavailable' }));
    host.postMessage({ kind: 'change', subscriptionId: 'sample-subscription', sequence: 2, value: 'late-token', cursor: '2' });
    dispose();
    await settle();
    expect(listener.mock.calls).toEqual([['sample-token'], [null]]);
    expect(frames(messages, 'unsubscribe')).toHaveLength(0);
    transport.close();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('forwards a file subscription opening fault to onError', async () => {
    const { client: transport, host, messages } = await connect();
    const client = createElectronPiskieClient({ transport, getPathForFile: vi.fn(), version: 'test', platform: 'linux' });
    const listener = vi.fn();
    const onError = vi.fn();
    client.desktop.files.observe('/sample/file.txt', listener, onError);
    await vi.waitFor(() => expect(frames(messages, 'subscribe')).toHaveLength(1));
    const subscribe = frames<{ kind: 'subscribe'; id: string }>(messages, 'subscribe')[0]!;
    host.postMessage({ kind: 'fault', id: subscribe.id, fault: {
      code: 'forbidden', message: 'Sample parent inaccessible', correlationId: 'sample-fault', retryable: false,
    } });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'forbidden' }));
    expect(listener).not.toHaveBeenCalled();
    transport.close();
  });

  it.each(['fault', 'subscribed'])('suppresses callbacks when a file observer is disposed before %s', async (kind) => {
    const { client: transport, host, messages } = await connect();
    const client = createElectronPiskieClient({ transport, getPathForFile: vi.fn(), version: 'test', platform: 'linux' });
    const listener = vi.fn();
    const onError = vi.fn();
    const dispose = client.desktop.files.observe('/sample/file.txt', listener, onError);
    await vi.waitFor(() => expect(frames(messages, 'subscribe')).toHaveLength(1));
    const subscribe = frames<{ kind: 'subscribe'; id: string }>(messages, 'subscribe')[0]!;
    dispose();
    host.postMessage(kind === 'fault' ? {
      kind, id: subscribe.id, fault: { code: 'unavailable', message: 'Sample watch unavailable', correlationId: 'sample-fault', retryable: false },
    } : { kind, id: subscribe.id, subscriptionId: 'sample-subscription', snapshot: 'sample-token', cursor: '0' });
    if (kind === 'subscribed') {
      await vi.waitFor(() => expect(frames(messages, 'unsubscribe')).toEqual([{ kind: 'unsubscribe', subscriptionId: 'sample-subscription' }]));
    } else await settle();
    expect(listener).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    transport.close();
  });

  it('rejects a malformed welcome instead of throwing from the message callback', async () => {
    const client = new ElectronPreloadClient({
      rendererBuildId: '0.1.0',
      windowNonce: 'window-test',
      connectTimeoutMs: 1_000,
    });
    const call = electron.postMessage.mock.calls.at(-1) as [string, unknown, MessagePort[]];
    const host = call[2][0]!;
    host.start();
    openPorts.push(host);
    host.postMessage({ kind: 'welcome', welcome: null });

    await expect(client.connected()).rejects.toThrow('Welcome payload must be an object');
  });
});
