import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Eye, EyeOff, Pencil, Plug2, Search, Star } from 'lucide-react';
import { createUuid } from '@shared/utils/identifiers';
import type { SearchDocument, SearchProviderConfig } from '../../../../shared/types/web-search';
import { Toggle } from '../../../components/task-definition/controls';
import { useProxyStore } from '../../../store/proxyStore';
import { useWebSearchStore } from '../../../store/webSearchStore';
import { messageText, rawText, type PresentationText } from '../../../i18n/presentationText';
import { BrandMark } from '../bits/BrandMark';
import { DeckSelect } from '../bits/DeckSelect';
import styles from '../deck.module.css';

interface TestOutcome {
  revision: number;
  kind: 'connection' | 'search';
  state: 'passed' | 'failed' | 'cancelled';
  errorCode?: string;
  retryAfterMs?: number;
  document?: SearchDocument;
  durationMs?: number;
}

export const SearchDesk: React.FC<{
  providerId: string;
  sessionId: string;
  onFlash(text: PresentationText, tone?: 'halt' | 'hold' | 'calm'): void;
}> = ({ providerId, sessionId, onFlash }) => {
  const { t } = useTranslation();
  const { config, presets, isApplying, updateProvider, removeProvider, setDefaultProvider,
    connecting, authorizationResults, connectOAuth, cancelOAuth, disconnectOAuth, waitForSaves } = useWebSearchStore();
  const proxyPool = useProxyStore((state) => state.config);
  const fetchProxyPool = useProxyStore((state) => state.fetchConfig);
  const provider = config?.providers[providerId];
  const preset = presets.find((item) => item.id === providerId);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [keyShown, setKeyShown] = useState(false);
  const [armedKill, setArmedKill] = useState(false);
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState<'connection' | 'search' | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const operation = useRef<string | null>(null);
  const cancelledOperations = useRef(new Set<string>());
  const save = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);

  useEffect(() => { if (!proxyPool) void fetchProxyPool(); }, [proxyPool, fetchProxyPool]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (operation.current) void window.piskie.webSearch.cancelOperation(operation.current).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!armedKill) return;
    const timer = setTimeout(() => setArmedKill(false), 3000);
    return () => clearTimeout(timer);
  }, [armedKill]);

  if (!provider || !preset || !config) return null;
  const current = config.defaultProvider === providerId;
  const oauth = preset.authentication.find((item) => item.kind === 'oauth');
  const apiKeyAuth = preset.authentication.find((item) => item.kind === 'api_key');

  const commitDrafts = async (): Promise<boolean> => {
    if (save.current) return save.current;
    const updates: { -readonly [K in keyof SearchProviderConfig]?: SearchProviderConfig[K] } = {};
    if (nameDraft !== null && nameDraft.trim() && nameDraft.trim() !== provider.displayName) updates.displayName = nameDraft.trim();
    if (keyDraft !== null && keyDraft.trim() !== (provider.apiKey ?? '')) updates.apiKey = keyDraft.trim() || undefined;
    if (Object.keys(updates).length === 0) { setNameDraft(null); setKeyDraft(null); return true; }
    save.current = updateProvider(providerId, updates);
    try {
      const saved = await save.current;
      if (saved) {
        setNameDraft((current) => current === nameDraft ? null : current);
        setKeyDraft((current) => current === keyDraft ? null : current);
      }
      return saved;
    } finally { save.current = null; }
  };

  const runTest = async (kind: 'connection' | 'search') => {
    if (operation.current) return;
    const operationId = createUuid();
    operation.current = operationId;
    setTesting(kind);
    setOutcome(null);
    try {
      if (!await commitDrafts()) return;
      await waitForSaves();
      if (!mounted.current || cancelledOperations.current.has(operationId)) return;
      const revision = useWebSearchStore.getState().config!.revision;
      const options = { operationId, revision, sessionId };
      const started = performance.now();
      const result = kind === 'connection'
        ? await window.piskie.webSearch.checkConnection(providerId, options)
        : await window.piskie.webSearch.testSearch(providerId, query.trim(), options);
      if (!mounted.current || operation.current !== operationId || cancelledOperations.current.has(operationId)) return;
      if (!result.ok) {
        if ('cancelled' in result) { setOutcome({ kind, revision, state: 'cancelled' }); return; }
        setOutcome({ kind, revision, state: 'failed', errorCode: result.failure.code, retryAfterMs: result.failure.retryAfterMs });
      } else {
        setOutcome({ kind, revision, state: 'passed', document: result.value?.document,
          durationMs: result.value?.diagnostics.durationMs ?? Math.round(performance.now() - started) });
      }
    } catch (error) {
      if (!mounted.current) return;
      if (!cancelledOperations.current.has(operationId)) onFlash(rawText(error instanceof Error ? error.message : String(error)), 'halt');
    } finally {
      cancelledOperations.current.delete(operationId);
      if (operation.current === operationId) operation.current = null;
      if (mounted.current) setTesting(null);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(keyDraft ?? provider.apiKey ?? '');
      onFlash(messageText('settings.provider.copied'));
    } catch (error) { onFlash(rawText(String(error)), 'halt'); }
  };

  const freshOutcome = outcome?.revision === config.revision ? outcome : null;
  const stale = outcome !== null && !freshOutcome;
  return <>
    <div className={styles.deskHead}>
      <span className={styles.deskGlyph}><BrandMark brand={providerId} title={preset.label} size={28} /></span>
      <span className={styles.deskIdent}>
        <div className={styles.deskTitle}>
          {nameDraft !== null ? <span className={styles.textIn}><input autoFocus disabled={isApplying} value={nameDraft} maxLength={40}
            aria-label={t('settings.provider.providerName')} onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => void commitDrafts()} onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setNameDraft(null);
            }} /></span> : <><span>{provider.displayName}</span><button type="button" className={styles.orbBtn}
              aria-label={t('settings.provider.rename')} onClick={() => setNameDraft(provider.displayName)}><Pencil size={12} /></button></>}
        </div>
        <div className={styles.deskSub}>
          {current && <span className={styles.liveTag}>{t('settings.webSearch.currentLabel')}</span>}
          <span>{preset.label}</span><span>{t('settings.webSearch.title')}</span>
        </div>
      </span>
      <span className={styles.headSpring} />
      <span className={styles.headActs}>
        <Toggle on={provider.enabled} disabled={isApplying} ariaLabel={t('settings.provider.enableProviderAria', { name: provider.displayName })}
          onFlip={(enabled) => void updateProvider(providerId, { enabled })} />
        <button type="button" className={styles.btn} disabled={!provider.enabled || current || isApplying}
          onClick={() => void setDefaultProvider(providerId)}><Star size={13} />{t('settings.provider.setCurrent')}</button>
        <button type="button" className={`${styles.btn} ${styles.btnRisk} ${armedKill ? styles.btnArmed : ''}`} disabled={isApplying}
          onClick={() => { if (armedKill) void removeProvider(providerId); else setArmedKill(true); }}>
          {armedKill ? t('settings.provider.confirmDelete') : t('common.delete')}
        </button>
      </span>
    </div>
    <div className={styles.deskBody}>
      {!config.enabled && <div className={styles.fieldNote}>{t('settings.webSearch.disabledHint')}</div>}
      <div className={styles.slab}>
        <div className={styles.slabCap}>{t('settings.provider.connection')}</div>
        <label className={styles.fieldTag}>{t('settings.webSearch.authentication')}</label>
        <DeckSelect ariaLabel={t('settings.webSearch.authentication')} value={provider.authentication} disabled={isApplying}
          options={preset.authentication.map((item) => ({ value: item.kind, label: t(`settings.webSearch.${item.kind}`) }))}
          onPick={(authentication) => void updateProvider(providerId, { authentication: authentication as SearchProviderConfig['authentication'] })} />
        {provider.authentication === 'anonymous' && <div className={styles.fieldNote}>{t('settings.webSearch.anonymousHint')}</div>}
        {provider.authentication === 'api_key' && <>
          <label className={styles.fieldTag}>{t('settings.provider.apiKey')}</label>
          <span className={`${styles.textIn} ${styles.monoIn}`}>
            <input type={keyShown ? 'text' : 'password'} autoComplete="new-password" disabled={isApplying} value={keyDraft ?? provider.apiKey ?? ''}
              aria-label={t('settings.provider.apiKey')} onChange={(event) => setKeyDraft(event.target.value)} onBlur={() => void commitDrafts()} />
            <button type="button" className={styles.inMiniBtn} aria-label={t(keyShown ? 'settings.provider.hideKey' : 'settings.provider.showKey')}
              onClick={() => setKeyShown(!keyShown)}>{keyShown ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            <button type="button" className={styles.inMiniBtn} aria-label={t('settings.provider.copyKey')} onClick={() => void copyKey()}><Copy size={13} /></button>
          </span>
          {!provider.apiKey?.trim() && <div className={styles.fieldNote}>{t('settings.webSearch.keyRequired')}</div>}
          {apiKeyAuth && <button type="button" className={`${styles.btn} ${styles.btnQuiet}`}
            onClick={() => void window.piskie.desktop.system.openExternal(apiKeyAuth.signupUrl)}>{t('settings.webSearch.getKey')}</button>}
        </>}
        {oauth && <div className={styles.rowLine}>
          <span className={styles.rowMain}><span className={styles.rowName}>{t('settings.webSearch.account', { name: preset.label })}</span>
            <span className={styles.rowNote}>{t(connecting[providerId] ? 'settings.webSearch.authorizing'
              : preset.oauth.connected ? 'settings.webSearch.connected' : 'settings.webSearch.disconnected')}</span>
            {authorizationResults[providerId] === 'cancelled' && <span className={styles.rowNote}>{t('settings.webSearch.cancelled')}</span>}</span>
          {connecting[providerId] ? <button type="button" className={styles.btn} onClick={() => void cancelOAuth(providerId)}>{t('common.cancel')}</button> : <>
            <button type="button" className={styles.btn} disabled={isApplying} onClick={() => void commitDrafts().then((saved) => { if (saved) void connectOAuth(providerId); })}>
              {t(preset.oauth.connected ? 'settings.webSearch.reconnect' : 'settings.webSearch.connect')}</button>
            {preset.oauth.connected && <button type="button" className={`${styles.btn} ${styles.btnRisk}`}
              onClick={() => void disconnectOAuth(providerId)}>{t('settings.webSearch.disconnect')}</button>}
          </>}
        </div>}
        <label className={styles.fieldTag}>{t('settings.provider.networkProxy')}</label>
        <DeckSelect ariaLabel={t('settings.provider.networkProxy')} value={provider.proxyId ?? '__direct__'} disabled={isApplying}
          options={[{ value: '__direct__', label: t('settings.provider.direct') }, ...(proxyPool?.proxies ?? [])
            .filter((proxy) => proxy.enabled || proxy.id === provider.proxyId).map((proxy) => ({ value: proxy.id, label: proxy.name }))]}
          onPick={(id) => void updateProvider(providerId, { proxyId: id === '__direct__' ? undefined : id })} />
      </div>
      <div className={styles.slab}>
        <div className={styles.slabCap}>{t('settings.webSearch.testTitle')}<span className={styles.capSpring} />
          {preset.connectionCheck && <button type="button" className={styles.btn} disabled={Boolean(testing) || !provider.enabled}
            onClick={() => void runTest('connection')}><Plug2 size={13} />{t(testing === 'connection' ? 'settings.provider.testing' : 'settings.provider.testConnection')}</button>}
        </div>
        <div className={styles.fieldNote}>{t('settings.webSearch.connectionHint')}</div>
        <label className={styles.fieldTag}>{t('settings.webSearch.query')}</label>
        <span className={styles.textIn}><Search size={14} /><input value={query} disabled={Boolean(testing)} aria-label={t('settings.webSearch.query')}
          placeholder={t('settings.webSearch.queryPlaceholder')} onChange={(event) => setQuery(event.target.value)} /></span>
        <div className={styles.fieldNote}>{t('settings.webSearch.searchHint')}</div>
        <button type="button" className={`${styles.btn} ${styles.btnPrime}`} disabled={Boolean(testing) || !provider.enabled || !query.trim()}
          onClick={() => void runTest('search')}>{t(testing === 'search' ? 'settings.provider.testing' : 'settings.webSearch.testSearch')}</button>
        {testing && <button type="button" className={styles.btn} onClick={() => {
          if (operation.current) {
            cancelledOperations.current.add(operation.current);
            setOutcome({ kind: testing, revision: config.revision, state: 'cancelled' });
            void window.piskie.webSearch.cancelOperation(operation.current).catch((error: unknown) => {
              onFlash(rawText(error instanceof Error ? error.message : String(error)), 'halt');
            });
          }
        }}>{t('common.cancel')}</button>}
        <div role="status" className={styles.fieldNote}>
          {stale && t('settings.webSearch.staleTest')}
          {freshOutcome?.state === 'passed' && t(freshOutcome.kind === 'connection' ? 'settings.webSearch.connectionPassed' : 'settings.webSearch.searchPassed', { ms: freshOutcome.durationMs })}
          {freshOutcome?.state === 'cancelled' && t('settings.webSearch.cancelled')}
          {freshOutcome?.state === 'failed' && t(`settings.webSearch.errors.${freshOutcome.errorCode}`)}
          {freshOutcome?.retryAfterMs !== undefined && t('settings.webSearch.retryAfter', { seconds: Math.ceil(freshOutcome.retryAfterMs / 1000) })}
        </div>
        {freshOutcome?.document && <div className={styles.searchEvidence}>
          {freshOutcome.document.evidence.kind === 'text' ? <pre>{freshOutcome.document.evidence.text}</pre>
            : freshOutcome.document.evidence.sources.length === 0 ? <p>{t('settings.webSearch.noResults')}</p>
              : freshOutcome.document.evidence.sources.map((source, index) => <article key={`${index}:${source.url}`}>
                <a href={source.url} onClick={(event) => { event.preventDefault(); void window.piskie.desktop.system.openExternal(source.url); }}>
                  {source.title || source.url}</a>
                <div className={styles.rowNote}>{source.url}{source.publishedDate ? ` · ${source.publishedDate}` : ''}</div>
                {source.excerpts.map((excerpt, i) => <p key={i}>{excerpt}</p>)}
              </article>)}
          {freshOutcome.document.notices?.map((notice, index) => <p key={index}>{notice}</p>)}
        </div>}
      </div>
    </div>
  </>;
};
