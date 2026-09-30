/** Three-dot entry point; actions and submenus are shared with useContextMenu. */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

import { Popover } from './Popover';
import { MenuContent, type MenuItemDescriptor } from './MenuContent';
import { observeMenuTarget } from './menuEvents';
import styles from './chrome.module.css';

export type { MenuItemDescriptor } from './MenuContent';

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenAtPointerDown = useRef(false);
  const hasItems = items.length > 0;

  useEffect(() => {
    if (!open || !hasItems || !triggerRef.current) return;
    return observeMenuTarget(triggerRef.current, close);
  }, [open, hasItems, close]);

  if (!hasItems && open) setOpen(false);
  if (!hasItems) return null;

  return (
    <Popover
      open={open}
      onClose={close}
      placement={placement}
      className={styles.menuPopover}
      trigger={
        <button
          ref={triggerRef}
          type="button"
          className={triggerClassName ?? styles.menuTrigger}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onPointerDown={() => { wasOpenAtPointerDown.current = open; }}
          onClick={(event) => {
            event.stopPropagation();
            // Native light-dismiss may close the popover before the mouse click.
            setOpen(event.detail === 0 ? !open : !wasOpenAtPointerDown.current);
          }}
        >
          {children ?? <MoreVertical size={12} />}
        </button>
      }
    >
      {open && <MenuContent items={items} onSelect={onSelect} onClose={close} ariaLabel={ariaLabel} />}
    </Popover>
  );
}

export const MenuButton = memo(MenuButtonImpl) as typeof MenuButtonImpl;
