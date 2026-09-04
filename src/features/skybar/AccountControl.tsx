import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  LogIn,
  LogOut,
  Settings,
  UserRound,
  X,
} from 'lucide-react';

import { PopShell } from '../../components/shared/PopShell';
import { useAccountStore } from '../../store/accountStore';
import { formatSignInCountdown } from '../account/signInCountdown';
import styles from './skybar.module.css';

export const AccountControl: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openAtPointerDown = useRef(false);
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

  const account = status?.state === 'signed-in' ? status : undefined;
  const isWaiting = phase === 'beginning' || phase === 'waiting';
  const isLoading = phase === 'loading';
  const displayName = account?.user.name || account?.user.email.split('@')[0];
  const triggerText = displayName
    || (isLoading
      ? t('skybar.account.loading')
      : isWaiting
        ? t('skybar.account.waiting')
        : t('skybar.account.signedOut'));
  const triggerStatus = account
    ? t('skybar.account.signedInAs', { name: displayName })
    : isWaiting
      ? t('skybar.account.waiting')
      : isLoading
        ? t('skybar.account.loading')
        : t('skybar.account.signedOut');
  const tone = account
    ? account.connection
    : isWaiting
      ? 'waiting'
      : 'signed-out';
  const errorText = error ? t(`settings.account.errors.${error}`) : undefined;

  const openSettings = (): void => {
    setOpen(false);
    navigate('/preferences?sect=account');
  };

  const avatar = (size: number): React.ReactNode => {
    if (isLoading || phase === 'beginning' || phase === 'signing-out') {
      return <LoaderCircle className={styles.accountSpin} size={size} aria-hidden="true" />;
    }
    if (account) {
      return <span aria-hidden="true">{initialOf(displayName || account.user.email)}</span>;
    }
    return <UserRound size={size} aria-hidden="true" />;
  };

  return (
    <PopShell
      open={open}
      onClose={() => setOpen(false)}
      triggerClassName={styles.accountAnchor}
      trigger={(
        <button
          type="button"
          className={styles.accountTrigger}
          data-tone={tone}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('skybar.account.openMenu', { status: triggerStatus })}
          onPointerDown={() => {
            openAtPointerDown.current = open;
          }}
          onClick={() => setOpen(!openAtPointerDown.current)}
        >
          <span className={styles.accountTriggerAvatar}>
            {avatar(14)}
            <i className={styles.accountPresence} aria-hidden="true" />
          </span>
          <span className={styles.accountTriggerText}>{triggerText}</span>
          <ChevronDown className={styles.accountChevron} size={12} aria-hidden="true" />
        </button>
      )}
    >
      <div className={styles.accountPanel} role="dialog" aria-label={t('settings.account.pageTitle')}>
        <div className={styles.accountPanelHead}>
          <span className={styles.accountPanelAvatar} data-tone={tone}>
            {avatar(17)}
          </span>
          <span className={styles.accountPanelIdentity}>
            <strong>{displayName || t('settings.account.pageTitle')}</strong>
            <span>{account?.user.email || triggerStatus}</span>
          </span>
          {account && (
            <span className={styles.accountConnection} data-tone={account.connection}>
              <i aria-hidden="true" />
              {account.connection === 'verified'
                ? t('skybar.account.signedIn')
                : t('settings.account.offline')}
            </span>
          )}
        </div>

        {errorText && <p className={styles.accountPanelError} role="alert">{errorText}</p>}

        {isLoading && (
          <div className={styles.accountPanelState} role="status">
            <LoaderCircle className={styles.accountSpin} size={15} aria-hidden="true" />
            {t('settings.account.loading')}
          </div>
        )}

        {!isLoading && challenge && (
          <div className={styles.accountPanelPending}>
            <div className={styles.accountPanelState} role="status" aria-live="polite">
              <ExternalLink size={14} aria-hidden="true" />
              {t('settings.account.pendingTitle')}
            </div>
            <span className={styles.accountPanelTimer} role="timer">
              {t('settings.account.expiresIn', {
                time: formatSignInCountdown(remainingSeconds),
              })}
            </span>
            <div className={styles.accountPanelSplitActions}>
              <button type="button" onClick={() => void reopenSignIn()}>
                <ExternalLink size={13} aria-hidden="true" />
                {t('settings.account.reopen')}
              </button>
              <button type="button" onClick={() => void cancelSignIn()}>
                <X size={13} aria-hidden="true" />
                {t('settings.account.cancel')}
              </button>
            </div>
          </div>
        )}

        {!isLoading && !challenge && !account && (
          <div className={styles.accountPanelActions}>
            <button
              type="button"
              className={styles.accountPanelPrimary}
              disabled={phase === 'beginning'}
              onClick={() => void beginSignIn()}
            >
              {phase === 'beginning'
                ? <LoaderCircle className={styles.accountSpin} size={14} aria-hidden="true" />
                : <LogIn size={14} aria-hidden="true" />}
              {phase === 'beginning'
                ? t('settings.account.connecting')
                : t('settings.account.signIn')}
            </button>
            <button type="button" onClick={openSettings}>
              <Settings size={14} aria-hidden="true" />
              {t('skybar.account.settings')}
            </button>
          </div>
        )}

        {account && (
          <div className={styles.accountPanelActions}>
            <button type="button" onClick={openSettings}>
              <Settings size={14} aria-hidden="true" />
              {t('skybar.account.settings')}
            </button>
            <button
              type="button"
              className={styles.accountPanelRisk}
              disabled={phase === 'signing-out'}
              onClick={() => void signOut()}
            >
              {phase === 'signing-out'
                ? <LoaderCircle className={styles.accountSpin} size={14} aria-hidden="true" />
                : <LogOut size={14} aria-hidden="true" />}
              {phase === 'signing-out'
                ? t('settings.account.signingOut')
                : t('settings.account.signOut')}
            </button>
          </div>
        )}
      </div>
    </PopShell>
  );
};

function initialOf(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || 'P';
}
