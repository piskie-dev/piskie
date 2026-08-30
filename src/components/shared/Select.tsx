/**
 * Select —— 原生 `<select>` + `appearance: base-select`。
 *
 * 选项在 2–4 个、无搜索无分组时用原生 select 就够，不必为定制外观去和
 * 组件库的内部 DOM 结构搏斗。浏览器负责键盘导航（上下键 + 首字母跳转）、
 * 可访问性、top layer 弹出层、点外关闭；这里只写样式
 * （`::picker(select)` / `option` / `::checkmark`）。
 *
 * 不写这套样式的裸 `<select>`，弹出列表由系统渲染，深色主题下是浅底白字。
 * 页面里需要下拉选择一律走这个组件。
 *
 * 约束（来自 `custom-select-picker-layouts` 指导）：原生 select 强制**一维上下键导航**，
 * 因此选项必须是纵向列表。要做二维网格就得回到 `role="listbox"` 自定义实现——
 * 本组件不承担那种场景。
 */

import React, { useCallback } from 'react';

import styles from './Select.module.css';

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** 展开列表中追加到标签后的纯文本说明 */
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface SelectProps<T extends string> {
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  /** 无障碍名称；没有可见 label 时必填 */
  readonly ariaLabel?: string;
  readonly id?: string;
  /** field = 表单里的样子（有边框、有箭头）；bare = 工具栏里的样子 */
  readonly variant?: 'bare' | 'field';
  readonly className?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  id,
  variant = 'bare',
  className,
}: SelectProps<T>): React.ReactElement {
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onChange(event.target.value as T);
    },
    [onChange],
  );

  const selected = options.find((option) => option.value === value);

  return (
    <select
      id={id}
      className={`${styles.select} ${variant === 'field' ? styles.field : ''} ${className ?? ''}`}
      value={value}
      onChange={handleChange}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {/* 闭合状态只显示 label，展开列表再显示可选的 hint。 */}
      <button type="button">
        <span className={styles.label}>{selected?.label ?? value}</span>
      </button>

      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.hint ? `${option.label} · ${option.hint}` : option.label}
        </option>
      ))}
    </select>
  );
}
