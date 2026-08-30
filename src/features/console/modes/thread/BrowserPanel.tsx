/**
 * BrowserPanel —— thread 右栏「浏览器」面板的渲染层外壳。
 *
 * 真正的页面是主进程的 WebContentsView（原生视图浮在本组件的占位区域上），
 * 这里只负责三件事：
 * 1. 工具栏（后退/前进/刷新 + 地址栏），状态来自主进程推送；
 * 2. 占位区域测量 → IPC setBounds（ResizeObserver + window resize）；
 * 3. 可见性协调：挂载即显示、卸载即隐藏（页面状态在主进程，不丢）；
 *    应用浮层（弹窗/抽屉/灯箱）在场时隐藏视图（overlayPresence，z-order）。
 *
 * 人驱动的干净浏览器：与 agent 的自动化浏览器完全隔离，永不接自动化。
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { EmbeddedBrowserState } from '../../../../../shared/types/embedded-browser';
import { getOverlayCount, subscribeOverlay } from '../../chrome/overlayPresence';
import styles from './browserPanel.module.css';

const EMPTY_STATE: EmbeddedBrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

const api = () => window.piskie.pilot.embeddedBrowser;

export const BrowserPanel = memo(() => {
  const { t } = useTranslation();
  const [state, setState] = useState<EmbeddedBrowserState>(EMPTY_STATE);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayCount = useSyncExternalStore(subscribeOverlay, getOverlayCount);

  // 状态订阅 + 初始快照
  useEffect(() => {
    let alive = true;
    void api().state().then((next) => {
      if (alive) setState(next);
    });
    const off = api().observeState((next) => setState(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 地址栏跟随页面（编辑中不打断）
  useEffect(() => {
    if (!editing) setDraft(state.url);
  }, [editing, state.url]);

  // 占位区域测量 → 主进程 setBounds
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const report = () => {
      const rect = host.getBoundingClientRect();
      void api().setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(host);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, []);

  // 可见性：挂载显示、卸载隐藏；浮层在场时让位（z-order）
  useEffect(() => {
    void api().setVisible(overlayCount === 0);
    return () => {
      void api().setVisible(false);
    };
  }, [overlayCount]);

  const submit = useCallback(() => {
    const value = draft.trim();
    setEditing(false);
    if (value) void api().navigate(value);
  }, [draft]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.navButton}
          disabled={!state.canGoBack}
          onClick={() => void api().back()}
          aria-label={t('sessionWorkbenchUi.browser.back')}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          className={styles.navButton}
          disabled={!state.canGoForward}
          onClick={() => void api().forward()}
          aria-label={t('sessionWorkbenchUi.browser.forward')}
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          className={styles.navButton}
          onClick={() => void (state.loading ? api().stop() : api().reload())}
          aria-label={state.loading
            ? t('sessionWorkbenchUi.browser.stop')
            : t('sessionWorkbenchUi.browser.refresh')}
        >
          {state.loading ? <X size={13} /> : <RotateCw size={13} />}
        </button>

        <div className={styles.address} data-loading={state.loading ? 'true' : undefined}>
          <Globe size={12} className={styles.addressIcon} />
          <input
            className={styles.addressInput}
            value={draft}
            placeholder={t('sessionWorkbenchUi.browser.addressPlaceholder')}
            spellCheck={false}
            onFocus={(event) => {
              setEditing(true);
              event.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                setDraft(state.url);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      </div>

      {/* 原生视图覆盖区：主进程按此矩形摆放 WebContentsView */}
      <div ref={hostRef} className={styles.viewHost}>
        {!state.url && (
          <div className={styles.empty}>
            <Globe size={20} />
            <span>{t('sessionWorkbenchUi.browser.empty')}</span>
          </div>
        )}
      </div>
    </div>
  );
});

BrowserPanel.displayName = 'BrowserPanel';
