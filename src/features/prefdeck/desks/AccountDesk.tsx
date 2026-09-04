import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ExternalLink,
  LoaderCircle,
  LogIn,
  LogOut,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';

import { formatSignInCountdown } from '../../account/signInCountdown';
import { useAccountStore } from '../../../store/accountStore';
import styles from '../deck.module.css';

const ACCOUNT_TITLE_ID = 'piskie-account-title';

export const AccountDesk: React.FC = () => {
  const { t } = useTranslation();
  const status = useAccountStore((state) => state.status);
  const challenge = useAccountStore((state) => state.challenge);
  const phase = useAccountStore((state) => state.phase);
  const error = useAccountStore((state) => state.error);
  const remainingSeconds = useAccountStore((state) => state.remainingSeconds);
  const initialize = useAccountStore((state) => state.initialize);
  const beginSignIn = useAccountStore((state) => state.beginSignIn);
  const reopenSignIn = useAccountStore((state) => state.reopenSignIn);
  const cancelSignIn = useAccountStore((state) => state.cancelSignIn);
  const signOut = useAccountStore((state) => state.signOut);
  useEffect(() => {
    void initialize();
  }, [initialize]);

  const errorText = error ? t(`settings.account.errors.${error}`) : undefined;

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskGlyph}><UserRound size={19} /></span>
        <div className={styles.deskIdent}>
          <h1 id={ACCOUNT_TITLE_ID} className={styles.deskTitle}>
            <span>{t('settings.account.pageTitle')}</span>
          </h1>
          <div className={styles.deskSub}>{t('settings.account.pageSubtitle')}</div>
        </div>
      </div>

      <div className={styles.deskBody}>
        <section className={styles.accountSlab} aria-labelledby={ACCOUNT_TITLE_ID}>
          {phase === 'loading' && (
            <div className={styles.accountCentered} aria-live="polite">
              <LoaderCircle className={styles.accountSpin} size={22} aria-hidden="true" />
              <span>{t('settings.account.loading')}</span>
            </div>
          )}

          {phase !== 'loading' && challenge && (
            <div className={styles.accountCentered}>
              <span className={styles.accountHeroIcon} data-tone="waiting">
                <ExternalLink size={22} aria-hidden="true" />
              </span>
              <div role="status" aria-live="polite" aria-atomic="true">
                <h2 className={styles.accountTitle}>{t('settings.account.pendingTitle')}</h2>
                <p className={styles.accountCopy}>{t('settings.account.pendingNote')}</p>
              </div>
              <p className={`${styles.fieldNote} ${styles.accountExpiry}`} role="timer">
                {t('settings.account.expiresIn', {
                  time: formatSignInCountdown(remainingSeconds),
                })}
              </p>
              <div className={styles.accountActions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrime}`}
                  onClick={() => void reopenSignIn()}
                >
                  <ExternalLink size={13} /> {t('settings.account.reopen')}
                </button>
                <button type="button" className={styles.btn} onClick={() => void cancelSignIn()}>
                  <X size={13} /> {t('settings.account.cancel')}
                </button>
              </div>
            </div>
          )}

          {phase !== 'loading' && !challenge && status?.state === 'signed-in' && (
            <div className={styles.accountSignedIn}>
              <div className={styles.accountIdentity}>
                <span className={styles.accountAvatar} aria-hidden="true">
                  {(status.user.name || status.user.email).slice(0, 1).toUpperCase()}
                </span>
                <div className={styles.accountIdentityText}>
                  <strong>{status.user.name || status.user.email.split('@')[0]}</strong>
                  <span>{status.user.email}</span>
                </div>
                <span className={styles.chip} data-state={status.connection === 'verified' ? 'prime' : undefined}>
                  {status.connection === 'verified'
                    ? t('settings.account.verified')
                    : t('settings.account.offline')}
                </span>
              </div>
              <div className={styles.accountFact}>
                <span><ShieldCheck size={14} /> {t('settings.account.credentialStorage')}</span>
                <strong>
                  {status.credentialStorage === 'secure'
                    ? t('settings.account.secureStorage')
                    : t('settings.account.sessionStorage')}
                </strong>
              </div>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnRisk} ${styles.accountSignOut}`}
                disabled={phase === 'signing-out'}
                onClick={() => void signOut()}
              >
                {phase === 'signing-out'
                  ? <LoaderCircle className={styles.accountSpin} size={13} />
                  : <LogOut size={13} />}
                {phase === 'signing-out' ? t('settings.account.signingOut') : t('settings.account.signOut')}
              </button>
            </div>
          )}

          {phase !== 'loading' && !challenge && status?.state !== 'signed-in' && (
            <div className={styles.accountCentered}>
              <span className={styles.accountHeroIcon}>
                {phase === 'beginning'
                  ? <LoaderCircle className={styles.accountSpin} size={22} aria-hidden="true" />
                  : <LogIn size={22} aria-hidden="true" />}
              </span>
              <div>
                <h2 className={styles.accountTitle}>{t('settings.account.signedOutTitle')}</h2>
                <p className={styles.accountCopy}>{t('settings.account.signedOutNote')}</p>
              </div>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrime}`}
                disabled={phase === 'beginning'}
                onClick={() => void beginSignIn()}
              >
                {phase === 'beginning'
                  ? <LoaderCircle className={styles.accountSpin} size={13} />
                  : <LogIn size={13} />}
                {phase === 'beginning' ? t('settings.account.connecting') : t('settings.account.signIn')}
              </button>
            </div>
          )}

          {errorText && <p className={styles.accountError} role="alert">{errorText}</p>}
        </section>
      </div>
    </>
  );
};
