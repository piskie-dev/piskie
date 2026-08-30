/**
 * NumberField —— antd InputNumber(size=small)的像素级复刻(去 antd)。
 *
 * 复刻依据为 antd v5 源码的 token 求值(2026-08-25 实测导出):
 * 高 24 / 圆角 6 / 边框 --cyber-border / 底 --cyber-bg / 字 14px / 内衬 0 7px;
 * hover 边框转主色;聚焦叠 2px 主色 22% 光环(controlOutline);
 * 右侧 22px 步进列悬停浮现,分隔线同边框色,步进钮 hover 转主色并微扩。
 * 全部色值经 tokens.css 变量表达,深浅主题随全局切换(与 antd 主题桥同源)。
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import styles from './numberField.module.css';

export interface NumberFieldProps {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

function clamp(value: number, min?: number, max?: number): number {
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

export const NumberField: React.FC<NumberFieldProps> = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  className = '',
  ariaLabel,
  disabled = false,
}) => {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);

  const commit = (): void => {
    editing.current = false;
    const parsed = Number.parseInt(text, 10);
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed, min, max);
      setText(String(next));
      if (next !== value) onChange(next);
      return;
    }
    setText(String(value));
  };

  const stepBy = (direction: 1 | -1): void => {
    const next = clamp(value + direction * step, min, max);
    editing.current = false;
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <span className={`${styles.field} ${className}`} data-disabled={disabled || undefined}>
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={ariaLabel}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          editing.current = true;
          setText(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          else if (event.key === 'ArrowUp') { event.preventDefault(); stepBy(1); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); stepBy(-1); }
        }}
      />
      <span className={styles.steps} aria-hidden>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || (max !== undefined && value >= max)}
          onClick={() => stepBy(1)}
        >
          <ChevronUp size={8} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || (min !== undefined && value <= min)}
          onClick={() => stepBy(-1)}
        >
          <ChevronDown size={8} strokeWidth={2.5} />
        </button>
      </span>
    </span>
  );
};
