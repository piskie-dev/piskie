/**
 * Divider —— 可拖拽分栏条。
 *
 * **拖拽期间零 React 渲染**：`pointermove` 直接把新宽度写进目标元素的 CSS 自定义属性
 * （`element.style.setProperty(cssVar, ...)`），grid 的 `grid-template-columns` 引用该变量。
 * 不进 React 状态 → 不 reconcile → 不重排整棵树。
 *
 * 双击复位到默认值（因此不需要"整理画布"那种可见按钮）。
 * 键盘可达：聚焦后左右方向键按 16px 调整（分隔条也要能用键盘操作）。
 */

import React, { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './chrome.module.css';

export interface DividerProps {
  /** 要写入的 CSS 自定义属性名，如 `--col-main` */
  readonly cssVar: string;
  /** 承载该变量的元素（通常是 grid 容器）；ref 由使用方持有 */
  readonly targetRef: React.RefObject<HTMLElement | null>;
  /** 默认值（双击复位用），如 `clamp(260px, 26%, 520px)` 或 `240px` */
  readonly defaultValue: string;
  /**
   * 被调整的元素。**建议传**：自定义属性未注册时 `getComputedStyle` 返回的是原始 token
   * （如 `clamp(260px, 26%, 520px)`），`parseFloat` 得 NaN，首次拖拽会跳到 min。
   * 传了就直接量它的真实像素宽，拖拽从当前位置连续开始。
   */
  readonly measureRef?: React.RefObject<HTMLElement | null>;
  readonly min: number;
  readonly max: number;
  readonly orientation?: 'vertical' | 'horizontal';
  /**
   * 被调整的那一栏在分隔条的**哪一侧**。决定拖动方向的符号：
   * - `leading`（默认）：栏在分隔条前面（左/上）⇒ 往右/下拖是**变宽**；
   * - `trailing`：栏在分隔条后面（右/下）⇒ 往右/下拖是**变窄**。
   *
   * 缺这个语义时右栏会反向（往右拖分隔条却往左跑）——因为尺寸永远是"加位移"，
   * 而右侧栏的宽度是从右边缘长出来的。
   */
  readonly pane?: 'leading' | 'trailing';
  readonly ariaLabel: string;
}

export const Divider = memo<DividerProps>(
  ({
    cssVar,
    targetRef,
    measureRef,
    defaultValue,
    min,
    max,
    orientation = 'vertical',
    pane = 'leading',
    ariaLabel,
  }) => {
    const { t } = useTranslation();
    /** 位移→尺寸的符号：trailing 栏从右/下边缘长出，位移与尺寸变化相反 */
    const sign = pane === 'trailing' ? -1 : 1;
    const dividerRef = useRef<HTMLButtonElement>(null);
    const dragRef = useRef<{ start: number; startSize: number } | null>(null);

    const currentSize = useCallback((): number => {
      // 优先量真实元素：自定义属性可能是 clamp()/百分比，parse 不出像素
      const measured = measureRef?.current;
      if (measured) {
        const rect = measured.getBoundingClientRect();
        return orientation === 'vertical' ? rect.width : rect.height;
      }

      const target = targetRef.current;
      if (!target) return min;
      const resolved = getComputedStyle(target).getPropertyValue(cssVar).trim();
      const parsed = Number.parseFloat(resolved);
      if (Number.isFinite(parsed)) {
        // 百分比换算成像素，保证拖拽是线性的
        return resolved.endsWith('%')
          ? (target.getBoundingClientRect().width * parsed) / 100
          : parsed;
      }
      return min;
    }, [cssVar, measureRef, min, orientation, targetRef]);

    const syncAriaValue = useCallback((size: number) => {
      const clamped = Math.min(max, Math.max(min, size));
      dividerRef.current?.setAttribute('aria-valuenow', String(Math.round(clamped)));
    }, [max, min]);

    const write = useCallback(
      (size: number) => {
        const clamped = Math.min(max, Math.max(min, size));
        targetRef.current?.style.setProperty(cssVar, `${Math.round(clamped)}px`);
        syncAriaValue(clamped);
      },
      [cssVar, max, min, syncAriaValue, targetRef],
    );

    useLayoutEffect(() => {
      const measured = measureRef?.current ?? targetRef.current;
      const update = () => syncAriaValue(currentSize());
      update();
      if (!measured) return;
      const observer = new ResizeObserver(update);
      observer.observe(measured);
      return () => observer.disconnect();
    }, [currentSize, measureRef, syncAriaValue, targetRef]);

    const onPointerDown = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = 'true';
        // 拖动期间全局压掉文本选择与光标闪烁：指针捕获只保证事件流向分隔条，
        // 浏览器该选的文字照样会选——横穿中栏拖一次就把整段正文刷蓝了。
        // 标在 <html> 上（带方向），由 base.css 的全局规则消费。
        document.documentElement.dataset.dividerDragging = orientation;
        const startSize = currentSize();
        syncAriaValue(startSize);
        dragRef.current = {
          start: orientation === 'vertical' ? event.clientX : event.clientY,
          startSize,
        };
      },
      [currentSize, orientation, syncAriaValue],
    );

    const onPointerMove = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        const position = orientation === 'vertical' ? event.clientX : event.clientY;
        write(drag.startSize + sign * (position - drag.start));
      },
      [orientation, sign, write],
    );

    const endDrag = useCallback((element: HTMLButtonElement, pointerId?: number) => {
      dragRef.current = null;
      delete element.dataset.dragging;
      delete document.documentElement.dataset.dividerDragging;
      if (pointerId !== undefined && element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    }, []);

    const onPointerUp = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => endDrag(event.currentTarget, event.pointerId),
      [endDrag],
    );

    /**
     * 捕获被系统收走时（切应用、触控板手势打断等）也要收尾，
     * 否则 <html> 上的拖动标记留着，全局就一直禁着文本选择。
     */
    const onLostPointerCapture = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => endDrag(event.currentTarget),
      [endDrag],
    );

    const onDoubleClick = useCallback(() => {
      targetRef.current?.style.setProperty(cssVar, defaultValue);
      requestAnimationFrame(() => {
        syncAriaValue(currentSize());
      });
    }, [cssVar, currentSize, defaultValue, syncAriaValue, targetRef]);

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const step =
          orientation === 'vertical'
            ? event.key === 'ArrowLeft'
              ? -16
              : event.key === 'ArrowRight'
                ? 16
                : 0
            : event.key === 'ArrowUp'
              ? -16
              : event.key === 'ArrowDown'
                ? 16
                : 0;
        if (step === 0) return;
        event.preventDefault();
        // 键盘与鼠标同一语义：方向键表达"分隔条往哪边动"，不是"栏变大还是变小"
        write(currentSize() + sign * step);
      },
      [currentSize, orientation, sign, write],
    );

    return (
      <button
        ref={dividerRef}
        type="button"
        className={styles.divider}
        data-orientation={orientation}
        role="separator"
        aria-label={ariaLabel}
        aria-orientation={orientation}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={min}
        title={t('sharedUi.divider.keyboardHint', { label: ariaLabel })}
        onFocus={() => syncAriaValue(currentSize())}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onLostPointerCapture}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      />
    );
  },
);

Divider.displayName = 'Divider';
