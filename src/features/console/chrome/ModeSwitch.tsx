/**
 * ModeSwitch —— 模式切换胶囊。
 *
 * 放在页面壳而不是某个模式内部：切的是整个页面形态，两个模式都不拥有它。
 *
 * 两个选项互斥，用 `radiogroup` 语义（不是 tab：切换的是整个页面形态，不是同级内容）。
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare, Workflow } from 'lucide-react';

import styles from './chrome.module.css';

export type ConsoleModeKey = 'dock' | 'thread';

export interface ModeSwitchProps {
  readonly mode: ConsoleModeKey;
  readonly onChange: (mode: ConsoleModeKey) => void;
}

/**
 * 按**形态**命名：thread 是沉浸式对话流 ⇒ 「对话」+ 气泡图标；
 * dock 是节点画布 ⇒ 「画布」+ 节点连线图标。
 * 两者的 cell 呈现与侧栏一致，差别只剩画布。
 */
const OPTIONS: readonly { key: ConsoleModeKey; labelKey: string; icon: React.ReactNode }[] = [
  { key: 'thread', labelKey: 'sessionWorkbenchUi.mode.conversation', icon: <MessagesSquare size={11} /> },
  { key: 'dock', labelKey: 'sessionWorkbenchUi.mode.canvas', icon: <Workflow size={11} /> },
];

export const ModeSwitch = memo<ModeSwitchProps>(({ mode, onChange }) => {
  const { t } = useTranslation();
  return (
    <div
      className={styles.modeSwitch}
      role="radiogroup"
      aria-label={t('sessionWorkbenchUi.mode.selectorLabel')}
      data-console-mode-switch
    >
      {OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          role="radio"
          aria-checked={mode === option.key}
          aria-label={t(option.labelKey)}
          className={styles.modeOption}
          data-selected={mode === option.key ? 'true' : undefined}
          onClick={() => onChange(option.key)}
        >
          {option.icon}
          <span data-mode-label>{t(option.labelKey)}</span>
        </button>
      ))}
    </div>
  );
});

ModeSwitch.displayName = 'ModeSwitch';
