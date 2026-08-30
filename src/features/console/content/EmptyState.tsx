/**
 * EmptyState —— **两模式共用**的空态。
 *
 * 三条约定：
 *
 * 1. **composer 贴底，不居中**：这是不变量——输入框在
 *    空态/活跃态 × dock/thread 四种组合里纵向位置不变，切模式不会让人找不到输入框。
 * 2. **composer 以插槽传入**：本组件不碰模型/模式/审批控件，也不碰发送逻辑；
 *    附件区、粘贴处理、textarea 测高全在 `content/Composer` 那一份里。
 * 3. **进场动画走 CSS**：`@starting-style`，不引动画库。
 *
 * 「最近任务模板」由调用方给（模式层知道 `useHistoryRows` / TaskDefinition 从哪来），
 * 本组件只管呈现与回传选择。
 */

import React, { memo } from 'react';
import { Lightbulb } from 'lucide-react';

import styles from './EmptyState.module.css';

export interface EmptyTemplate {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** 右下角的次要信息（最近活跃时间、工作区名…） */
  readonly meta?: string;
}

export interface EmptyStateProps {
  readonly logoSrc: string;
  readonly tagline: string;
  /** 随机功能提示；不传即不出 */
  readonly tip?: string;
  readonly templates?: readonly EmptyTemplate[];
  readonly onPickTemplate?: (id: string) => void;
  /** composer 插槽——**必须**渲染在底部（不变量） */
  readonly composer: React.ReactNode;
}

export const EmptyState = memo<EmptyStateProps>(
  ({ logoSrc, tagline, tip, templates, onPickTemplate, composer }) => (
    <div className={styles.empty}>
      <div className={styles.stage}>
        <div className={styles.hero}>
          <img src={logoSrc} alt="Piskie" className={`${styles.logo} app-logo-adaptive`} />
          <p className={styles.tagline}>{tagline}</p>
        </div>

        {tip && (
          <span className={styles.tip}>
            <Lightbulb size={13} className={styles.tipIcon} />
            <span>{tip}</span>
          </span>
        )}

        {templates && templates.length > 0 && (
          <div className={styles.templates}>
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className={styles.template}
                onClick={() => onPickTemplate?.(template.id)}
              >
                <span className={styles.templateTitle}>{template.title}</span>
                {template.description && (
                  <span className={styles.templateDescription}>{template.description}</span>
                )}
                {template.meta && <span className={styles.templateMeta}>{template.meta}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.footer}>{composer}</div>
    </div>
  ),
);

EmptyState.displayName = 'EmptyState';
