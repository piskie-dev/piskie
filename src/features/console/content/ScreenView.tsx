/**
 * ScreenView —— 实时流预览外壳。
 *
 * 预览就是辅助面板里的一块内容：**填满容器**，宽高由面板给，展开缩小由面板分隔条承担。
 * 组件自身不做 collapsed / expanded 尺寸模式，也不额外包一层供画布挂 `Handle` 的节点壳。
 *
 * 保真度：`fidelity === 'hidden'` 时停帧但不拆流。
 */

import { memo, useCallback, useEffect } from 'react';
import { Eye, Loader2, Maximize2, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../chrome/Tooltip';
import type { Fidelity } from '../data/visibility';
import { formatFps } from './screen/formatFps';
import { useCaptureSize } from './screen/useCaptureSize';
import { useRemoteInput } from './screen/useRemoteInput';
import { showBrowserWindow } from './screen/showBrowserWindow';
import { useScreenViewport } from './screen/useScreenViewport';
import styles from './screen/screen.module.css';

// ==================== 浏览器流 ====================

export interface BrowserScreenViewProps {
  readonly subagentId: string;
  readonly browserId: string;
  /** 浏览器未就绪时不订阅，只显示等待态 */
  readonly browserReady: boolean;
  readonly title?: string;
  readonly fidelity?: Fidelity;
  readonly onFullscreen?: () => void;
  /**
   * 允许在画面里直接操作被控浏览器。
   * 内核仍是外部 fingerprint-chromium，输入经 CDP 转发，不改变指纹与自动化特征。
   */
  readonly interactive?: boolean;
  /**
   * 流的真实宽高比(宽/高)可用或变化时上报。screencast 缩放保持页面视口
   * 宽高比,所以它就是被控浏览器视口的真实比例——画布节点用它定默认尺寸。
   */
  readonly onFrameRatio?: (ratio: number) => void;
}

export const BrowserScreenView = memo<BrowserScreenViewProps>(
  ({
    subagentId,
    browserId,
    browserReady,
    title,
    fidelity = 'visible',
    onFullscreen,
    interactive = false,
    onFrameRatio,
  }) => {
    const { t } = useTranslation();
    // 头部标题是字面量，`title` 只用于无障碍名（全屏弹窗另有自己的标题）
    void title;
    const [viewportRef, capture] = useCaptureSize();

    const stream = useScreenViewport({
      browserId,
      agentId: subagentId,
      enabled: browserReady,
      // 30 而非 24：everyNthFrame 是整数分频，24 会取整成 N=3（实际 20fps），30 正好 N=2
      fps: 30,
      paused: fidelity === 'hidden',
      capture,
    });

    const onShowWindow = useCallback(() => {
      void showBrowserWindow(browserId);
    }, [browserId]);

    const input = useRemoteInput({
      enabled: interactive && stream.ready,
      frameSize: stream.frameSize,
      send: stream.sendInput,
    });

    const frameRatio =
      stream.frameSize?.width && stream.frameSize.height
        ? stream.frameSize.width / stream.frameSize.height
        : null;

    useEffect(() => {
      if (frameRatio) onFrameRatio?.(frameRatio);
    }, [frameRatio, onFrameRatio]);

    return (
      <div className={styles.view}>
        {/* 画面**填满**面板：面板是竖的、画面近方形，等比装进去必然留边。
            改为 cover 语义——铺满两个方向，溢出的那一维由本容器滚动够到。
            帧尺寸未知（首帧未到）时不启用，避免初始尺寸塌成 0 */}
        <div
          className={styles.viewport}
          data-fit={frameRatio ? 'fill' : undefined}
          style={frameRatio ? ({ ['--frame-ratio' as string]: `${frameRatio}` }) : undefined}
        >
          {/* 舞台=画面的真实显示矩形（可大于视口）。canvas 与输入宿主都铺满它，
              于是输入坐标换算天然正确：宿主的 getBoundingClientRect 就是画面矩形，
              滚动后也自动跟着变。采集分辨率也按舞台量（比视口大，采得更清）。 */}
          <div className={styles.stage} ref={viewportRef}>
            <canvas
              key={stream.canvasKey}
              ref={stream.canvasRef}
              className={styles.canvas}
              data-visible={stream.ready ? 'true' : 'false'}
            />

            {/* 输入宿主：盖住画面接管指针/键盘 */}
            {interactive && (
              <div
                ref={input.ref}
                className={styles.inputHost}
                tabIndex={0}
                role="application"
                aria-label={t('sessionWorkbenchUi.screen.interactiveAria')}
                data-active={stream.ready ? 'true' : 'false'}
                onPointerDown={input.onPointerDown}
                onPointerMove={input.onPointerMove}
                onPointerUp={input.onPointerUp}
                onPointerCancel={input.onPointerUp}
                onKeyDown={input.onKeyDown}
                onKeyUp={input.onKeyUp}
                onContextMenu={input.onContextMenu}
              />
            )}
          </div>

          {/* 覆盖层挂在视口上（不随内容滚动） */}
          {!browserReady && (
            <div className={styles.overlay}>
              <Loader2 size={22} className="animate-spin" />
              <span>{t('sessionWorkbenchUi.screen.waitingBrowser')}</span>
            </div>
          )}

          {browserReady && !stream.ready && !stream.error && (
            <div className={styles.overlay} data-tone="loading">
              <Loader2 size={22} className="animate-spin" />
            </div>
          )}

          {browserReady && stream.error && !stream.ready && (
            <div className={styles.overlay} data-tone="error">
              <Unplug size={22} />
              <span>{stream.error}</span>
            </div>
          )}

          {/* 画面内悬浮控件：常态可发现，指针移入时增强 */}
          <div className={styles.floatBar}>
            {browserReady && (
              <span className={styles.floatChip}>
                <span
                  className={styles.statusDot}
                  data-state={stream.ready ? 'ready' : stream.error ? 'error' : undefined}
                  aria-hidden="true"
                />
                {formatFps(stream.currentFps)} FPS
              </span>
            )}
            {onFullscreen ? (
              <Tooltip title={t('sessionWorkbenchUi.screen.fullscreen')}>
                <button
                  type="button"
                  className={styles.floatButton}
                  onClick={onFullscreen}
                  aria-label={t('sessionWorkbenchUi.screen.fullscreen')}
                >
                  <Maximize2 size={14} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip title={t('sessionWorkbenchUi.screen.showBrowserWindow')}>
                <button type="button" className={styles.floatButton} onClick={onShowWindow} aria-label={t('sessionWorkbenchUi.screen.showBrowserWindow')}>
                  <Eye size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    );
  },
);

BrowserScreenView.displayName = 'BrowserScreenView';
