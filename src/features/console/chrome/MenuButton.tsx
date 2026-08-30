/**
 * MenuButton —— 溢出菜单。
 *
 * 「按 key 分发 + 阻止冒泡到卡片 + 选完即关」收在这一处，使用方（会话卡片、历史项、
 * 生图节点…）不各写一遍：
 * 菜单项是**描述符**（key/label/danger/icon），可见性由调用方的纯策略函数算
 * （如 `data/sessionMenu`），组件不判断业务条件。
 *
 * 开合状态是组件级临时态（关掉不损失信息），light-dismiss 与 Esc 由
 * `Popover` 的原生 popover 承担。
 */

import React, { memo, useCallback, useState } from 'react';
import { MoreVertical } from 'lucide-react';

import { Popover } from './Popover';
import styles from './chrome.module.css';

export interface MenuItemDescriptor<K extends string = string> {
  readonly key: K;
  readonly label: string;
  readonly danger?: boolean;
  readonly icon?: React.ReactNode;
}

export interface MenuButtonProps<K extends string = string> {
  readonly items: readonly MenuItemDescriptor<K>[];
  readonly onSelect: (key: K) => void;
  readonly ariaLabel: string;
  /** 触发器内容；默认三点图标 */
  readonly children?: React.ReactNode;
  readonly triggerClassName?: string;
  readonly placement?: 'block-end' | 'block-start' | 'inline-end' | 'inline-start';
}

function MenuButtonImpl<K extends string>({
  items,
  onSelect,
  ariaLabel,
  children,
  triggerClassName,
  placement,
}: MenuButtonProps<K>): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const pick = useCallback(
    (event: React.MouseEvent, key: K) => {
      // 菜单常挂在可点击的卡片里，不能让点击冒泡上去顺带选中卡片
      event.stopPropagation();
      setOpen(false);
      onSelect(key);
    },
    [onSelect],
  );

  if (items.length === 0) return null;

  return (
    <Popover
      open={open}
      onClose={close}
      placement={placement}
      trigger={
        <button
          type="button"
          className={triggerClassName ?? styles.menuTrigger}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          {children ?? <MoreVertical size={12} />}
        </button>
      }
    >
      <div className={styles.menuList} role="menu">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            data-danger={item.danger ? 'true' : undefined}
            onClick={(event) => pick(event, item.key)}
          >
            {item.icon && <span className={styles.menuIcon}>{item.icon}</span>}
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}

export const MenuButton = memo(MenuButtonImpl) as typeof MenuButtonImpl;
