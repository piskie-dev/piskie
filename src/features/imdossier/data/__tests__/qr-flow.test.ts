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
      start: vi.fn(async () => ({ qrDataUrl: 'data:image/png;base64,abc', message: 'scan from provider' })),
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
