import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccountClient,
  PiskieAccountStatus,
} from '../../../shared/electron-contracts';
import { resetAccountStore, useAccountStore } from '../accountStore';

const signedOut: PiskieAccountStatus = { state: 'signed-out' };
const signedIn: PiskieAccountStatus = {
  state: 'signed-in',
  user: {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada',
  },
  connection: 'verified',
  credentialStorage: 'secure',
};

beforeEach(() => resetAccountStore());

afterEach(() => {
  resetAccountStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('accountStore', () => {
  it('initializes the shared account status once', async () => {
    const status = vi.fn(async () => signedIn);
    installAccountClient({ status });

    await Promise.all([
      useAccountStore.getState().initialize(),
      useAccountStore.getState().initialize(),
    ]);

    expect(status).toHaveBeenCalledOnce();
    expect(useAccountStore.getState()).toMatchObject({
      initialized: true,
      status: signedIn,
      phase: 'idle',
    });
  });

  it('publishes a completed sign-in to every store consumer', async () => {
    const beginSignIn = vi.fn(async () => ({ flowId: 'flow-1', expiresAt: Date.now() + 60_000 }));
    const waitForSignIn = vi.fn(async () => signedIn);
    installAccountClient({ beginSignIn, waitForSignIn });
    await useAccountStore.getState().initialize();

    await useAccountStore.getState().beginSignIn();

    expect(beginSignIn).toHaveBeenCalledOnce();
    expect(waitForSignIn).toHaveBeenCalledWith('flow-1');
    expect(useAccountStore.getState()).toMatchObject({
      status: signedIn,
      challenge: undefined,
      phase: 'idle',
      error: undefined,
    });
  });

  it('cancels an active flow without allowing its late result to overwrite state', async () => {
    let rejectWait!: (reason: unknown) => void;
    const waitForSignIn = vi.fn(() => new Promise<PiskieAccountStatus>((_resolve, reject) => {
      rejectWait = reject;
    }));
    const cancelSignIn = vi.fn(async () => undefined);
    installAccountClient({ waitForSignIn, cancelSignIn });
    await useAccountStore.getState().initialize();

    const signingIn = useAccountStore.getState().beginSignIn();
    await vi.waitFor(() => expect(useAccountStore.getState().phase).toBe('waiting'));
    await useAccountStore.getState().cancelSignIn();
    rejectWait(new Error('cancelled'));
    await signingIn;

    expect(cancelSignIn).toHaveBeenCalledWith('flow');
    expect(useAccountStore.getState()).toMatchObject({
      status: signedOut,
      challenge: undefined,
      phase: 'idle',
      error: undefined,
    });
  });

  it('rejects a challenge that is already expired before waiting for its callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const waitForSignIn = vi.fn(async () => signedIn);
    const cancelSignIn = vi.fn(async () => undefined);
    installAccountClient({
      beginSignIn: vi.fn(async () => ({
        flowId: 'expired-flow',
        expiresAt: Date.now(),
      })),
      waitForSignIn,
      cancelSignIn,
    });
    await useAccountStore.getState().initialize();

    await useAccountStore.getState().beginSignIn();

    expect(waitForSignIn).not.toHaveBeenCalled();
    expect(cancelSignIn).toHaveBeenCalledWith('expired-flow');
    expect(useAccountStore.getState()).toMatchObject({
      challenge: undefined,
      phase: 'idle',
      error: 'expired',
    });
  });

  it('publishes sign-out immediately after the account service completes', async () => {
    const signOut = vi.fn(async () => signedOut);
    installAccountClient({ status: vi.fn(async () => signedIn), signOut });
    await useAccountStore.getState().initialize();

    await useAccountStore.getState().signOut();

    expect(signOut).toHaveBeenCalledOnce();
    expect(useAccountStore.getState()).toMatchObject({ status: signedOut, phase: 'idle' });
  });
});

function installAccountClient(overrides: Partial<AccountClient> = {}): void {
  const account: AccountClient = {
    status: vi.fn(async () => signedOut),
    beginSignIn: vi.fn(async () => ({ flowId: 'flow', expiresAt: Date.now() + 60_000 })),
    waitForSignIn: vi.fn(async () => signedIn),
    reopenSignIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => signedOut),
    ...overrides,
  };
  vi.stubGlobal('window', { piskie: { account } });
}
