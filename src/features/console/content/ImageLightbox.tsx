/**
 * ImageLightbox —— 当前会话图片的全屏浏览器。
 *
 * 用原生 `<dialog>` 呈现：top-layer 自动置顶（无需 Portal），Esc 由 dialog 原生关闭
 * （`cancel` 事件），左右键、两侧按钮与底部缩略图共用同一个当前索引。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ImageLightbox.module.css';

interface ImageLightboxProps {
  preview: {
    readonly urls: readonly string[];
    readonly index: number;
  } | null;
  onClose: () => void;
}

const ImageLightbox: React.FC<ImageLightboxProps> = ({ preview, onClose }) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<{
    readonly preview: ImageLightboxProps['preview'];
    readonly index: number;
  }>({ preview: null, index: 0 });

  const count = preview?.urls.length ?? 0;
  const activeIndex = preview && selection.preview === preview
    ? selection.index
    : (preview?.index ?? 0);
  const imageUrl = preview?.urls[activeIndex] ?? null;

  // 打开/关闭 dialog 与预览请求同步；关闭走原生动画（不立即 remove）
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (preview && imageUrl) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [imageUrl, preview]);

  useEffect(() => {
    if (count > 1) {
      activeThumbRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    }
  }, [activeIndex, count]);

  const select = useCallback((nextIndex: number) => {
    if (!preview || count < 1) return;
    setSelection({ preview, index: (nextIndex + count) % count });
  }, [count, preview]);

  const previous = useCallback(() => select(activeIndex - 1), [activeIndex, select]);
  const next = useCallback(() => select(activeIndex + 1), [activeIndex, select]);

  // dialog 的 cancel（Esc）与 close 都归一到 onClose
  const handleCancel = (event: React.SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };

  // backdrop 点击：事件目标是 dialog 本身（非内部内容）时关闭
  const handleClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (count < 2) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      previous();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      next();
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(count - 1);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.lightbox}
      onCancel={handleCancel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={t('sessionWorkbenchUi.lightbox.title')}
    >
      <button
        type="button"
        className={styles.dismiss}
        onClick={onClose}
        aria-label={t('sessionWorkbenchUi.lightbox.close')}
      >
        ✕
      </button>

      <div className={styles.browser} data-multiple={count > 1 ? 'true' : undefined}>
        <div className={styles.stage}>
          {count > 1 && (
            <button
              type="button"
              className={`${styles.nav} ${styles.previous}`}
              onClick={previous}
              aria-label={t('sessionWorkbenchUi.lightbox.previous')}
            />
          )}

          {imageUrl && (
            <div className={styles.frame}>
              <img
                key={`${activeIndex}:${imageUrl}`}
                className={styles.picture}
                src={imageUrl}
                alt={t('sessionWorkbenchUi.lightbox.imageAlt', {
                  current: activeIndex + 1,
                  total: count,
                })}
                draggable={false}
              />
            </div>
          )}

          {count > 1 && (
            <button
              type="button"
              className={`${styles.nav} ${styles.next}`}
              onClick={next}
              aria-label={t('sessionWorkbenchUi.lightbox.next')}
            />
          )}
        </div>

        {preview && count > 1 && (
          <div className={styles.filmstrip} aria-label={t('sessionWorkbenchUi.lightbox.thumbnails')}>
            <span className={styles.counter} aria-live="polite">
              {activeIndex + 1} / {count}
            </span>
            <div className={styles.rail}>
              {preview.urls.map((url, index) => (
                <button
                  key={`${url}:${index}`}
                  ref={index === activeIndex ? activeThumbRef : undefined}
                  type="button"
                  className={styles.thumbnail}
                  data-active={index === activeIndex ? 'true' : undefined}
                  onClick={() => select(index)}
                  aria-label={t('sessionWorkbenchUi.lightbox.openImage', { index: index + 1 })}
                  aria-current={index === activeIndex ? 'true' : undefined}
                >
                  <img src={url} alt="" draggable={false} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
};

export default ImageLightbox;
