/**
 * Panel —— 面板骨架。
 *
 * 底部功能带全部由 flex 排布，**组件不知道自己有多大**：
 *
 *   header   图标 · 标题 · 状态徽章 · 操作区
 *   error    错误/重试条（条件）
 *   body     flex:1，滚动区
 *   runtime  运行状态（条件）
 *   taskList 任务清单（条件）
 *   gate     审批门（pending 时替代 footer 中的输入器）
 *   footer   输入器后的常驻底部信息
 *
 * **零高度常量、零 ResizeObserver**：不允许出现"外部算好高度传进来再反推内部高度"的算式。
 *
 * `fidelity` 同时驱动 CSS（`content-visibility`）与调用方的订阅门控——
 * 两面都要做，"切走即冻结"才是真的。
 */

import React, { memo } from 'react';

import type { Fidelity } from '../../data/visibility';
import styles from './Panel.module.css';

export interface PanelProps {
  readonly title: React.ReactNode;
  readonly icon?: React.ReactNode;
  /**
   * 顶部 4px 状态细条的语气。
   * 不传即中性灰条——这条恒在，是 dock 面板的识别特征之一。
   */
  readonly statusTone?: 'running' | 'thinking' | 'waiting' | 'error';
  readonly statusPulse?: boolean;
  readonly status?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly runtime?: React.ReactNode;
  readonly taskList?: React.ReactNode;
  readonly gate?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly fidelity?: Fidelity;
  readonly children: React.ReactNode;
  readonly className?: string;
  /**
   * 键盘焦点作用域的认领钩子（`content/useActionScope` 的返回值直接铺开）。
   * 走**捕获**阶段：面板内的菜单、卡片大量 `stopPropagation`，冒泡阶段收不到。
   */
  readonly onPointerDownCapture?: () => void;
  readonly onFocusCapture?: () => void;
}

export const Panel = memo<PanelProps>(
  ({
    title,
    icon,
    statusTone,
    statusPulse,
    status,
    actions,
    error,
    runtime,
    taskList,
    gate,
    footer,
    fidelity = 'visible',
    children,
    className,
    onPointerDownCapture,
    onFocusCapture,
  }) => (
    <section
      className={`${styles.panel} ${className ?? ''}`}
      data-fidelity={fidelity}
      onPointerDownCapture={onPointerDownCapture}
      onFocusCapture={onFocusCapture}
    >
      {/* 顶部状态线：默认无色，有语气才浮现渐隐色线 */}
      <div
        className={styles.statusBar}
        data-tone={statusTone}
        data-pulse={statusPulse ? 'true' : undefined}
        aria-hidden="true"
      />

      <header className={styles.header}>
        {icon && <span className={styles.iconBox}>{icon}</span>}
        <div className={styles.headerMain}>
          <div className={styles.headerTitleRow}>
            <span className={styles.title}>{title}</span>
            {status}
          </div>
        </div>
        {actions && <div className={styles.headerActions}>{actions}</div>}
      </header>

      {error}

      <div className={styles.body}>{children}</div>

      {runtime && <div className={styles.runtime}>{runtime}</div>}
      {taskList && <div className={styles.taskList}>{taskList}</div>}

      {/* Gate 只替代输入器；footer 里的常驻指标仍继续展示。 */}
      {/*
        `nodrag nopan`：画布上的节点整体可拖，但**门与输入区不能当抓手** ——
        在输入框里按下拖动应该是选文本，不是把节点拖走。
        `nowheel`：ConversationComposer 的 textarea 超高后自己滚（max-block-size 240），
        不加的话在长草稿上滚滚轮会缩放整个画布。画布外三个类全部惰性。
      */}
      {gate && <div className={`${styles.gate} nodrag nopan nowheel`}>{gate}</div>}
      {footer && <div className={`${styles.footer} nodrag nopan nowheel`}>{footer}</div>}
    </section>
  ),
);

Panel.displayName = 'Panel';
