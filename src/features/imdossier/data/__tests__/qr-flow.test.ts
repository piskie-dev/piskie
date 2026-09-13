import { describe, expect, it, vi } from 'vitest';

import { messageText, rawText } from '../../../../i18n/presentationText';
import { createQrFlow, type QrView } from '../qr-flow';

function dependencies(
  views: QrView[],
  overrides: Partial<Parameters<typeof createQrFlow>[0]> = {},
): Parameters<typeof createQrFlow>[0] {
  return {
    botId: 'bot-1',
    channelType: 'openclaw-weixin',
    start: vi.fn(async () => null),
    wait: vi.fn(async () => null),
    submit: vi.fn(async () => null),
    cancel: vi.fn(async () => true),
    render: (view) => views.push(view),
    connected: vi.fn(),
    ...overrides,
  };
}

describe('QR flow presentation boundary', () => {
  it.each([undefined, ''])('shows the provider failure without polling when QR content is %s', async (qrDataUrl) => {
    const views: QrView[] = [];
    const deps = dependencies(views, {
      start: vi.fn(async () => ({ qrDataUrl, message: 'Provider could not generate a QR' })),
    });
    const flow = createQrFlow(deps);
    flow.begin(false);
    await vi.waitFor(() => expect(views.at(-1)).toEqual({
      phase: 'fault', qr: null, word: rawText('Provider could not generate a QR'),
    }));
    expect(deps.wait).not.toHaveBeenCalled();
    flow.dispose();
  });

  it('does not restart a login closed while cancellation is pending', async () => {
    let finishCancel!: (value: boolean) => void;
    const deps = dependencies([], {
      cancel: vi.fn(() => new Promise<boolean>((resolve) => { finishCancel = resolve; })),
    });
    const flow = createQrFlow(deps);
    flow.begin(true);
    const finishFirstCancel = finishCancel;
    expect(deps.start).not.toHaveBeenCalled();
    flow.dispose();
    finishFirstCancel(true);
    finishCancel(true);
    await Promise.resolve();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it.each(['connected', 'already_connected'])('preserves the successful %s account on close', async (state) => {
    const deps = dependencies([], {
      start: vi.fn(async () => ({ qrDataUrl: 'https://example.test/login', message: 'Scan' })),
      wait: vi.fn(async () => ({ connected: state === 'connected', state, message: 'Connected' })),
    });
    const flow = createQrFlow(deps);
    flow.begin(false);
    await vi.waitFor(() => expect(deps.connected).toHaveBeenCalledWith(state === 'already_connected'));
    flow.dispose();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('ignores a login result received after closing the flow', async () => {
    const views: QrView[] = [];
    let complete!: (value: { connected: boolean; state: string; message: string }) => void;
    const deps = dependencies(views, {
      start: vi.fn(async () => ({ qrDataUrl: 'https://example.test/login', message: 'Scan' })),
      wait: vi.fn(() => new Promise<{ connected: boolean; state: string; message: string }>((resolve) => {
        complete = resolve;
      })),
    });
    const flow = createQrFlow(deps);
    flow.begin(false);
    await vi.waitFor(() => expect(deps.wait).toHaveBeenCalledOnce());
    flow.dispose();
    const lastView = views.at(-1);
    complete({ connected: true, state: 'connected', message: 'Connected' });
    await Promise.resolve();
    expect(deps.connected).not.toHaveBeenCalled();
    expect(views.at(-1)).toBe(lastView);
  });

  it('emits locale keys for product-owned failures', async () => {
    const views: QrView[] = [];
    const flow = createQrFlow(dependencies(views));

    flow.begin(false);

    await vi.waitFor(() => {
      expect(views.at(-1)?.word).toEqual(messageText('imPlugin.qr.imageUnavailable'));
    });
    flow.dispose();
  });

  it('keeps connector messages as raw facts', async () => {
    const views: QrView[] = [];
    const flow = createQrFlow(dependencies(views, {
      start: vi.fn(async () => ({ qrDataUrl: 'https://liteapp.weixin.qq.com/?qrcode=test', message: 'scan from provider' })),
      wait: vi.fn(async () => ({
        connected: false,
        state: 'need_verify_code',
        message: 'provider verification prompt',
      })),
    }));

    flow.begin(false);

    await vi.waitFor(() => {
      expect(views).toContainEqual(expect.objectContaining({ word: rawText('scan from provider') }));
      expect(views.at(-1)?.word).toEqual(rawText('provider verification prompt'));
    });
    flow.dispose();
  });

  it('uses a locale key for local verification-code validation', () => {
    const views: QrView[] = [];
    const flow = createQrFlow(dependencies(views));

    flow.submitCode('not-a-code', null);

    expect(views.at(-1)?.word).toEqual(messageText('imPlugin.qr.codeShape'));
    flow.dispose();
  });
});
