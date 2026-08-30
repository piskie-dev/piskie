/**
 * InlineSelect —— 工具行里的内联参数下拉。
 *
 * 用 Chromium 的可定制 `<select>`（`appearance: base-select`）：触发钮 + `::picker`
 * 弹层全部由 CSS 定制，浏览器托管焦点、键盘导航、无障碍与 top-layer 呈现，
 * 无需自绘 popover。选项标签为纯文本，旧浏览器降级为系统下拉仍可读。
 */

import React from 'react';
import styles from './inlineSelect.module.css';

// <selectedcontent>（可定制 select 的选中项镜像元素）尚未进入 @types/react 的 JSX 内建元素。
// JSX.IntrinsicElements 扩展只能经 namespace 声明，此处豁免 no-namespace。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      selectedcontent: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export interface InlineOption {
  value: string;
  label: string;
}

interface InlineSelectProps {
  value: string;
  options: readonly InlineOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 无障碍名（无可见 label 时必填） */
  ariaLabel: string;
  className?: string;
}

export const InlineSelect: React.FC<InlineSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}) => (
  <select
    className={className ? `${styles.select} ${className}` : styles.select}
    value={value}
    disabled={disabled}
    aria-label={ariaLabel}
    onChange={(event) => onChange(event.target.value)}
  >
    {/* 自定义触发钮：<selectedcontent> 镜像当前选中项 */}
    <button type="button">
      <selectedcontent />
    </button>
    {options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);
