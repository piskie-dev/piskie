import { create } from 'zustand';

import {
  ACCOUNT_FAULT_REASONS,
  PiskieFault,
  type PiskieAccountSignInChallenge,
  type PiskieAccountStatus,
} from '../../shared/electron-contracts';

export type AccountPhase = 'loading' | 'idle' | 'beginning' | 'waiting' | 'signing-out';
export type AccountErrorKind = 'denied' | 'expired' | 'network' | 'generic';

interface AccountState {
  readonly initialized: boolean;
  readonly operationId: number;
  readonly status?: PiskieAccountStatus;
  readonly challenge?: PiskieAccountSignInChallenge;
  readonly remainingSeconds: number;
  readonly phase: AccountPhase;
  readonly error?: AccountErrorKind;
  initialize(): Promise<void>;
  beginSignIn(): Promise<void>;
  reopenSignIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  expireSignIn(flowId: string): Promise<void>;
  signOut(): Promise<void>;
  clearError(): void;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  initialized: false,
  operationId: 0,
  remainingSeconds: 0,
  phase: 'loading',

  initialize: async () => {
    const current = get();
    if (current.initialized) return;
    const operationId = current.operationId + 1;
    set({ initialized: true, operationId, phase: 'loading', error: undefined });
    try {
      const status = await window.piskie.account.status();
      if (get().operationId !== operationId) return;
      set({ status, phase: 'idle' });
    } catch (reason) {
      if (get().operationId !== operationId) return;
      set({
        status: { state: 'signed-out' },
        error: accountErrorKind(reason),
        phase: 'idle',
      });
    }
  },

  beginSignIn: async () => {
    const current = get();
    if (current.phase !== 'idle') return;
    const operationId = current.operationId + 1;
    stopAccountCountdown();
    set({
      operationId,
      challenge: undefined,
      remainingSeconds: 0,
      error: undefined,
      phase: 'beginning',
    });
    try {
      const challenge = await window.piskie.account.beginSignIn();
      if (get().operationId !== operationId) {
        await window.piskie.account.cancelSignIn(challenge.flowId).catch(() => undefined);
        return;
      }
      const remainingSeconds = secondsUntil(challenge.expiresAt);
      set({ challenge, remainingSeconds, phase: 'waiting' });
      if (remainingSeconds === 0) {
        await get().expireSignIn(challenge.flowId);
        return;
      }
      startAccountCountdown(challenge);
      const status = await window.piskie.account.waitForSignIn(challenge.flowId);
      if (get().operationId !== operationId) return;
      stopAccountCountdown();
      set({
        status,
        challenge: undefined,
        remainingSeconds: 0,
        error: undefined,
        phase: 'idle',
      });
    } catch (reason) {
      if (get().operationId !== operationId) return;
      stopAccountCountdown();
      set({
        challenge: undefined,
        remainingSeconds: 0,
        error: accountErrorKind(reason),
        phase: 'idle',
      });
    }
  },

  reopenSignIn: async () => {
    const active = get().challenge;
    if (!active) return;
    set({ error: undefined });
    try {
      await window.piskie.account.reopenSignIn(active.flowId);
    } catch (reason) {
      if (get().challenge?.flowId !== active.flowId) return;
      set({ error: accountErrorKind(reason) });
    }
  },

  cancelSignIn: async () => {
    const current = get();
    const operationId = current.operationId + 1;
    stopAccountCountdown();
    set({
      operationId,
      challenge: undefined,
      remainingSeconds: 0,
      error: undefined,
      phase: 'idle',
    });
    if (current.challenge) {
      await window.piskie.account.cancelSignIn(current.challenge.flowId).catch(() => undefined);
    }
  },

  expireSignIn: async (flowId) => {
    const current = get();
    if (current.challenge?.flowId !== flowId) return;
    stopAccountCountdown();
    set({
      operationId: current.operationId + 1,
      challenge: undefined,
      remainingSeconds: 0,
      error: 'expired',
      phase: 'idle',
    });
    await window.piskie.account.cancelSignIn(flowId).catch(() => undefined);
  },

  signOut: async () => {
    const current = get();
    if (current.phase !== 'idle' || current.status?.state !== 'signed-in') return;
    const operationId = current.operationId + 1;
    stopAccountCountdown();
    set({
      operationId,
      challenge: undefined,
      remainingSeconds: 0,
      error: undefined,
      phase: 'signing-out',
    });
    try {
      const status = await window.piskie.account.signOut();
      if (get().operationId !== operationId) return;
      set({ status, phase: 'idle' });
    } catch (reason) {
      if (get().operationId !== operationId) return;
      set({ error: accountErrorKind(reason), phase: 'idle' });
    }
  },

  clearError: () => set({ error: undefined }),
}));

let countdownTimer: ReturnType<typeof setInterval> | undefined;

function startAccountCountdown(challenge: PiskieAccountSignInChallenge): void {
  stopAccountCountdown();
  countdownTimer = setInterval(() => {
    const current = useAccountStore.getState();
    if (current.challenge?.flowId !== challenge.flowId) {
      stopAccountCountdown();
      return;
    }
    const remainingSeconds = secondsUntil(challenge.expiresAt);
    useAccountStore.setState({ remainingSeconds });
    if (remainingSeconds === 0) void current.expireSignIn(challenge.flowId);
  }, 1_000);
}

function stopAccountCountdown(): void {
  if (countdownTimer === undefined) return;
  clearInterval(countdownTimer);
  countdownTimer = undefined;
}

function secondsUntil(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
}

export function resetAccountStore(): void {
  stopAccountCountdown();
  const operationId = useAccountStore.getState().operationId + 1;
  useAccountStore.setState({
    initialized: false,
    operationId,
    status: undefined,
    challenge: undefined,
    remainingSeconds: 0,
    phase: 'loading',
    error: undefined,
  });
}

function accountErrorKind(reason: unknown): AccountErrorKind {
  if (!(reason instanceof PiskieFault)) return 'generic';
  if (reason.code === 'forbidden') return 'denied';
  if (
    reason.code === 'not-found'
    || (
      reason.code === 'deadline-exceeded'
      && reason.details?.reason === ACCOUNT_FAULT_REASONS.signInExpired
    )
  ) return 'expired';
  if (reason.code === 'deadline-exceeded' || reason.code === 'unavailable') return 'network';
  return 'generic';
}
