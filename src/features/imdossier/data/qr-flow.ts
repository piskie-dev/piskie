/**
 * weixin 扫码登录纯流程控制器（七阶段状态机）。
 *
 * 不碰 React:begin/submitCode/dispose 三操作,内部代际计数丢弃过期回调,
 * dispose 时未落地(未连接成功)则 cancelQrLogin。视图经 deps.render 回写。
 */

import {
  messageText,
  rawText,
  type PresentationText,
} from '../../../i18n/presentationText';

export type QrPhase = 'boot' | 'scan' | 'verify' | 'submitting' | 'expired' | 'blocked' | 'fault';

export interface QrView {
  phase: QrPhase;
  qr: string | null;
  word?: PresentationText;
}

interface QrFlowDeps {
  botId: string;
  channelType: string;
  start: (botId: string, channelType: string, force?: boolean) => Promise<{ qrDataUrl?: string; message: string } | null>;
  wait: (
    botId: string,
    channelType: string,
  ) => Promise<{ connected: boolean; state: string; message: string; alreadyConnected?: boolean } | null>;
  submit: (botId: string, channelType: string, code: string) => Promise<{ accepted: boolean; message: string } | null>;
  cancel: (botId: string, channelType: string) => Promise<boolean>;
  render: (view: QrView) => void;
  connected: (alreadyConnected: boolean) => void;
}

const CODE_SHAPE = /^\d{1,8}$/;

/** 纯流程控制器:begin/submitCode/dispose,内部代际防抖 */
export function createQrFlow(deps: QrFlowDeps) {
  let generation = 0;
  let landed = false;

  const paint = (gen: number, view: QrView): boolean => {
    if (gen !== generation) return false;
    deps.render(view);
    return true;
  };

  const awaitOutcome = async (gen: number, qr: string | null): Promise<void> => {
    const outcome = await deps.wait(deps.botId, deps.channelType);
    if (gen !== generation) return;
    if (!outcome) {
      paint(gen, {
        phase: 'fault',
        qr,
        word: messageText('imPlugin.qr.outcomeUnavailable'),
      });
      return;
    }
    if (outcome.connected || outcome.state === 'connected' || outcome.state === 'already_connected') {
      landed = true;
      deps.connected(outcome.alreadyConnected === true || outcome.state === 'already_connected');
      return;
    }
    switch (outcome.state) {
      case 'need_verify_code':
        paint(gen, { phase: 'verify', qr, word: rawText(outcome.message) });
        return;
      case 'expired':
        paint(gen, { phase: 'expired', qr: null, word: rawText(outcome.message) });
        return;
      case 'verify_code_blocked':
        paint(gen, { phase: 'blocked', qr: null, word: rawText(outcome.message) });
        return;
      default:
        paint(gen, { phase: 'fault', qr: null, word: rawText(outcome.message) });
    }
  };

  return {
    begin(force: boolean): void {
      const gen = ++generation;
      paint(gen, { phase: 'boot', qr: null });
      void (async () => {
        const started = await deps.start(deps.botId, deps.channelType, force);
        if (gen !== generation) return;
        if (!started) {
          paint(gen, {
            phase: 'fault',
            qr: null,
            word: messageText('imPlugin.qr.imageUnavailable'),
          });
          return;
        }
        const qr = started.qrDataUrl ?? null;
        paint(gen, { phase: 'scan', qr, word: rawText(started.message) });
        await awaitOutcome(gen, qr);
      })();
    },

    submitCode(code: string, qr: string | null): void {
      const gen = generation;
      if (!CODE_SHAPE.test(code)) {
        paint(gen, { phase: 'verify', qr, word: messageText('imPlugin.qr.codeShape') });
        return;
      }
      paint(gen, { phase: 'submitting', qr, word: messageText('imPlugin.qr.checkingCode') });
      void (async () => {
        const receipt = await deps.submit(deps.botId, deps.channelType, code);
        if (gen !== generation) return;
        if (!receipt || !receipt.accepted) {
          paint(gen, {
            phase: 'verify',
            qr,
            word: receipt?.message
              ? rawText(receipt.message)
              : messageText('imPlugin.qr.codeRejected'),
          });
          return;
        }
        paint(gen, { phase: 'scan', qr, word: rawText(receipt.message) });
        await awaitOutcome(gen, qr);
      })();
    },

    dispose(): void {
      generation += 1;
      if (!landed) void deps.cancel(deps.botId, deps.channelType);
    },
  };
}
