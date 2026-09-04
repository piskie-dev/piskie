export const ACCOUNT_OPERATIONS = Object.freeze({
  status: 'account.status',
  beginSignIn: 'account.signIn.begin',
  waitForSignIn: 'account.signIn.wait',
  reopenSignIn: 'account.signIn.reopen',
  cancelSignIn: 'account.signIn.cancel',
  signOut: 'account.signOut',
} as const);

export const ACCOUNT_FAULT_REASONS = Object.freeze({
  signInExpired: 'sign-in-expired',
} as const);

export interface PiskieAccountUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly image?: string;
}

export type PiskieAccountStatus =
  | { readonly state: 'signed-out' }
  | {
      readonly state: 'signed-in';
      readonly user: PiskieAccountUser;
      readonly connection: 'verified' | 'offline';
      readonly credentialStorage: 'secure' | 'session';
    };

export interface PiskieAccountSignInChallenge {
  /** Opaque local handle. OAuth codes, PKCE secrets, and tokens stay in the main process. */
  readonly flowId: string;
  readonly expiresAt: number;
}

export interface AccountClient {
  status(): Promise<PiskieAccountStatus>;
  beginSignIn(): Promise<PiskieAccountSignInChallenge>;
  waitForSignIn(flowId: string): Promise<PiskieAccountStatus>;
  reopenSignIn(flowId: string): Promise<void>;
  cancelSignIn(flowId: string): Promise<void>;
  signOut(): Promise<PiskieAccountStatus>;
}
