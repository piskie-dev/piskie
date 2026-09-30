import React, { useId, useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';

import { Popover } from './Popover';
import styles from './chrome.module.css';

export interface MenuItemDescriptor<K extends string = string> {
  readonly key: K;
  readonly label: string;
  readonly danger?: boolean;
  readonly icon?: React.ReactNode;
  /** Start a new group before this item. */
  readonly separatorBefore?: boolean;
  readonly disabled?: boolean;
  /** Visible explanation for a disabled action. */
  readonly disabledReason?: string;
  /** Supplying a boolean makes this a radio-style choice. */
  readonly checked?: boolean;
  /** A parent opens its submenu; only leaf keys are dispatched. */
  readonly children?: readonly MenuItemDescriptor<K>[];
}

export interface MenuContentProps<K extends string = string> {
  readonly items: readonly MenuItemDescriptor<K>[];
  readonly onSelect: (key: K) => void;
  readonly onClose: () => void;
  readonly ariaLabel: string;
}

/** Shared actions and presentation for button and mouse context menus. */
export function MenuContent<K extends string>({
  items,
  onSelect,
  onClose,
  ariaLabel,
}: MenuContentProps<K>): React.ReactElement {
  const [submenuKey, setSubmenuKey] = useState<K | null>(null);
  const id = useId();

  return (
    <div
      className={styles.menuList}
      role="menu"
      aria-label={ariaLabel}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onScroll={() => setSubmenuKey(null)}
    >
      {items.map((item, index) => {
        const hasSubmenu = Boolean(item.children?.length);
        const submenuOpen = hasSubmenu && !item.disabled && submenuKey === item.key;
        const reasonId = `${id}-${index}-reason`;
        const reason = item.disabled ? item.disabledReason : undefined;
        const button = (
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            className={styles.menuItem}
            data-danger={item.danger ? 'true' : undefined}
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            aria-describedby={reason ? reasonId : undefined}
            aria-checked={item.checked}
            aria-haspopup={hasSubmenu ? 'menu' : undefined}
            aria-expanded={hasSubmenu ? submenuOpen : undefined}
            onPointerEnter={() => { if (!hasSubmenu || item.disabled) setSubmenuKey(null); }}
            onClick={(event) => {
              event.stopPropagation();
              if (hasSubmenu) {
                setSubmenuKey(item.key);
              } else {
                onClose();
                onSelect(item.key);
              }
            }}
          >
            {item.checked !== undefined && (
              <span className={styles.menuIcon} aria-hidden="true">
                {item.checked ? <Check size={12} /> : <span className={styles.menuCheckSpace} />}
              </span>
            )}
            {item.icon && <span className={styles.menuIcon} aria-hidden="true">{item.icon}</span>}
            <span className={styles.menuText}>
              <span>{item.label}</span>
              {reason && <span id={reasonId} className={styles.menuReason}>{reason}</span>}
            </span>
            {hasSubmenu && <ChevronRight className={styles.menuSubmenuArrow} size={12} aria-hidden="true" />}
          </button>
        );

        return (
          <React.Fragment key={item.key}>
            {item.separatorBefore && index > 0 && <div className={styles.menuSeparator} role="separator" />}
            {hasSubmenu ? (
              <Popover
                open={submenuOpen}
                onClose={() => setSubmenuKey(null)}
                placement="inline-end"
                align="start"
                triggerClassName={styles.menuSubmenuTrigger}
                className={styles.menuPopover}
                trigger={button}
              >
                {submenuOpen && (
                  <MenuContent
                    items={item.children!}
                    onSelect={onSelect}
                    onClose={onClose}
                    ariaLabel={item.label}
                  />
                )}
              </Popover>
            ) : button}
          </React.Fragment>
        );
      })}
    </div>
  );
}
