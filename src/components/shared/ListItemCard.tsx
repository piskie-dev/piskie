/**
 * ListItemCard - 列表行卡片容器（Console 三阶递阶基准模式）
 *
 * 常态 → hover → 选中 三阶：surface-1/line-1 → surface-2/line-2 → surface-3/line-3 + 选中阴影。
 * 列表中可选中/可点击的行卡片一律使用本组件。
 */

import React from 'react';

interface ListItemCardProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
  disabled?: boolean;
  /** 是否有 hover 反馈与手型光标；默认在传入 onClick 时开启 */
  interactive?: boolean;
  children: React.ReactNode;
}

const ListItemCard: React.FC<ListItemCardProps> = ({
  selected = false,
  disabled = false,
  interactive,
  className = '',
  children,
  onClick,
  ...rest
}) => {
  const isInteractive = interactive ?? Boolean(onClick);

  const stateClasses = selected
    ? 'border-line-3 bg-surface-3 shadow-[var(--shadow-card-active)]'
    : `border-line-1 bg-surface-1${isInteractive ? ' hover:border-line-2 hover:bg-surface-2' : ''}`;

  return (
    <div
      className={`rounded-card border transition-all duration-200 ${stateClasses}${
        isInteractive ? ' cursor-pointer' : ''
      }${disabled ? ' opacity-60' : ''} ${className}`}
      onClick={onClick}
      {...rest}
    >
      {children}
    </div>
  );
};

export default ListItemCard;
