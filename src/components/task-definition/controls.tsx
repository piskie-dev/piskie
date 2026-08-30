/**
 * Task Definition 控件基元 —— 通电开关。
 *
 * 受控 switch 语义：亮起靠光不靠漆，主色只透边与光晕。
 */

import React from 'react';

import styles from './taskDefinitionModal.module.css';

export const Toggle: React.FC<{
  on: boolean;
  onFlip: (on: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}> = ({ on, onFlip, ariaLabel, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={ariaLabel}
    className={styles.toggle}
    disabled={disabled}
    onClick={() => onFlip(!on)}
  />
);
