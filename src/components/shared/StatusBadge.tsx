/**
 * StatusBadge - 状态徽章组件
 *
 * 统一 Console 状态色模式：文字 100% / 背景 12% / 边框 30%（bordered 时）。
 */

import React from 'react';

export type BadgeVariant = 'primary' | 'accent' | 'success' | 'warning' | 'error' | 'default';

interface StatusBadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
  dot?: boolean;
  size?: 'sm' | 'md';
  /** 显示 30% 透明度的同色边框 */
  bordered?: boolean;
  /** 状态点呼吸动画（需配合 dot） */
  pulse?: boolean;
  /** 前置图标（与 dot 互斥，icon 优先） */
  icon?: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, { text: string; bg: string; border: string; dot: string }> = {
  primary: {
    text: 'text-cyber-primary',
    bg: 'bg-cyber-primary/12',
    border: 'border-cyber-primary/30',
    dot: 'bg-cyber-primary',
  },
  accent: {
    text: 'text-cyber-accent',
    bg: 'bg-cyber-accent/12',
    border: 'border-cyber-accent/30',
    dot: 'bg-cyber-accent',
  },
  success: {
    text: 'text-status-running',
    bg: 'bg-status-running/12',
    border: 'border-status-running/30',
    dot: 'bg-status-running',
  },
  warning: {
    text: 'text-status-waiting',
    bg: 'bg-status-waiting/12',
    border: 'border-status-waiting/30',
    dot: 'bg-status-waiting',
  },
  error: {
    text: 'text-status-error',
    bg: 'bg-status-error/12',
    border: 'border-status-error/30',
    dot: 'bg-status-error',
  },
  default: {
    text: 'text-cyber-text-muted',
    bg: 'bg-surface-2',
    border: 'border-line-2',
    dot: 'bg-cyber-text-muted',
  },
};

const sizeStyles = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-[11px] px-2 py-0.5',
};

const StatusBadge: React.FC<StatusBadgeProps> = ({
  children,
  variant = 'default',
  className = '',
  dot = false,
  size = 'sm',
  bordered = false,
  pulse = false,
  icon,
}) => {
  const styles = variantStyles[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${styles.text} ${styles.bg} ${
        bordered ? `border ${styles.border}` : ''
      } ${sizeStyles[size]} ${className}`}
    >
      {icon}
      {!icon && dot && (
        <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}${pulse ? ' animate-pulse' : ''}`} />
      )}
      {children}
    </span>
  );
};

export default StatusBadge;
