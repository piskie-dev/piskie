/**
 * ScreenFullscreen —— 全屏实时预览。
 *
 * 形态：原生 `<dialog closedby="any">`（Esc 与点遮罩由浏览器管）承载接近整窗的监看台；
 * 全屏与小窗各持有一个 viewport lease，共享同一 agent 的 ScreenFeed。
 *
 * 全屏预览只读，不转发输入。
 */

import { memo, useCallback } from 'react';
import { Eye, Loader2, Unplug, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog } from '../chrome/Dialog';
import { Tooltip } from '../chrome/Tooltip';
import { formatFps } from './screen/formatFps';
import { showBrowserWindow } from './screen/showBrowserWindow';
import { useCaptureSize } from './screen/useCaptureSize';
import { useScreenViewport } from './screen/useScreenViewport';
import styles from './screen/screen.module.css';

export interface ScreenFullscreenProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly subagentId: string;
  readonly browserId: string;
  readonly title?: string;
}

export type ScreenFullscreenTarget = Pick<
  ScreenFullscreenProps,
  'subagentId' | 'browserId' | 'title'
>;

export const ScreenFullscreen = memo<ScreenFullscreenProps>(
  ({ open, onClose, subagentId, browserId, title }) => {
    const { t } = useTranslation();
    const resolvedTitle = title ?? t('sessionWorkbenchUi.screen.liveView');
    const [viewportRef, capture] = useCaptureSize();

    const stream = useScreenViewport({
      browserId,
      agentId: subagentId,
      enabled: open,
      // browser 侧 30 而非 24：everyNthFrame 整数分频，24 实际只有 20fps
      fps: 30,
      capture,
    });

    const focusBrowserWindow = useCallback(() => {
      void showBrowserWindow(browserId);
    }, [browserId]);

    const ratio = stream.frameSize?.width && stream.frameSize.height
      ? stream.frameSize.width / stream.frameSize.height
      : 16 / 9;
    const resolution = stream.frameSize
      ? `${stream.frameSize.width} × ${stream.frameSize.height}`
      : t('sessionWorkbenchUi.screen.waitingFirstFrame');

    return (
      <Dialog
        open={open}
        onClose={onClose}
        ariaLabel={`${resolvedTitle} · ${t('sessionWorkbenchUi.screen.monitoring')}`}
        className={styles.fullscreenDialog}
        bodyClassName={styles.fullscreenDialogBody}
      >
        <div className={styles.fullscreen} style={{ ['--frame-ratio' as string]: `${ratio}` }}>
          <header className={styles.fullscreenHeader}>
            <div className={styles.fullscreenIdentity}>
              <span className={styles.fullscreenKicker} data-ready={stream.ready ? 'true' : undefined}>
                <span className={styles.fullscreenSignalDot} aria-hidden="true" />
                {stream.ready
                  ? t('sessionWorkbenchUi.screen.monitoring')
                  : t('sessionWorkbenchUi.screen.connecting')}
              </span>
              <h2 className={styles.fullscreenTitle}>{resolvedTitle}</h2>
            </div>

            <div className={styles.fullscreenTelemetry} aria-live="polite">
              <span className={styles.fullscreenMetric}>
                <span className={styles.fullscreenMetricLabel}>{t('sessionWorkbenchUi.screen.picture')}</span>
                <span className={styles.fullscreenMetricValue}>{resolution}</span>
              </span>
              <span className={styles.fullscreenMetric}>
                <span className={styles.fullscreenMetricLabel}>{t('sessionWorkbenchUi.screen.frameRate')}</span>
                <span className={styles.fullscreenMetricValue}>{formatFps(stream.currentFps)} FPS</span>
              </span>

              <button
                type="button"
                className={styles.fullscreenWindowButton}
                onClick={focusBrowserWindow}
                aria-label={t('sessionWorkbenchUi.screen.showBrowserWindow')}
              >
                <Eye size={13} />
                <span className={styles.fullscreenButtonText}>{t('sessionWorkbenchUi.screen.browserWindow')}</span>
              </button>

              <Tooltip title={t('sessionWorkbenchUi.screen.close')}>
                <button
                  type="button"
                  className={styles.fullscreenCloseButton}
                  onClick={onClose}
                  aria-label={t('sessionWorkbenchUi.screen.closeFullscreen')}
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </div>
          </header>

          <div className={styles.fullscreenStage}>
            <div className={styles.fullscreenViewport} ref={viewportRef}>
              <canvas
                key={stream.canvasKey}
                ref={stream.canvasRef}
                className={`${styles.canvas} ${styles.fullscreenCanvas}`}
                data-visible={stream.ready ? 'true' : 'false'}
              />

              {!stream.ready && !stream.error && (
                <div className={`${styles.overlay} ${styles.fullscreenOverlay}`}>
                  <Loader2 size={24} className="animate-spin" />
                  <span className={styles.overlayTitle}>{t('sessionWorkbenchUi.screen.connectingLiveView')}</span>
                  <span className={styles.overlayHint}>{t('sessionWorkbenchUi.screen.autoFitHint')}</span>
                </div>
              )}

              {stream.error && (
                <div className={`${styles.overlay} ${styles.fullscreenOverlay}`} data-tone="error">
                  <Unplug size={22} />
                  <span className={styles.overlayTitle}>{stream.error}</span>
                  <span className={styles.overlayHint}>{t('sessionWorkbenchUi.screen.reconnectHint')}</span>
                </div>
              )}
            </div>

            <div className={styles.fullscreenStageMeta} aria-hidden="true">
              <span>{stream.ready
                ? t('sessionWorkbenchUi.screen.liveStatus')
                : t('sessionWorkbenchUi.screen.standbyStatus')}</span>
              <span>{t('sessionWorkbenchUi.screen.escapeHint')}</span>
            </div>
          </div>
        </div>
      </Dialog>
    );
  },
);

ScreenFullscreen.displayName = 'ScreenFullscreen';
