import React, { useCallback, useEffect, useState } from 'react';

import { MenuContent, type MenuItemDescriptor } from './MenuContent';
import { canOpenContextMenu, observeMenuTarget } from './menuEvents';
import { Popover } from './Popover';
import styles from './chrome.module.css';

export interface ContextMenuOptions<K extends string = string> {
  readonly items: readonly MenuItemDescriptor<K>[];
  readonly onSelect: (key: K) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}

export interface ContextMenuBinding {
  readonly onContextMenu: React.MouseEventHandler<HTMLElement>;
  readonly menu: React.ReactElement | null;
  readonly close: () => void;
}

interface ContextMenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly target: Element;
  readonly waitingForRelease: boolean;
}

/** Bind to one business object and render `menu` alongside it. No trigger is added. */
export function useContextMenu<K extends string>({
  items,
  onSelect,
  ariaLabel,
  disabled = false,
}: ContextMenuOptions<K>): ContextMenuBinding {
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const available = !disabled && items.length > 0;

  const onContextMenu = useCallback<React.MouseEventHandler<HTMLElement>>((event) => {
    if (!canOpenContextMenu(event)) return;
    // Even an unavailable nested object owns its area; do not open its parent's menu.
    event.stopPropagation();
    if (!available) return;
    event.preventDefault();
    setAnchor({
      x: event.clientX,
      y: event.clientY,
      target: event.target as Element,
      // Chromium can emit contextmenu before pointerup, which light-dismisses auto popovers.
      waitingForRelease: Boolean(event.buttons & 2),
    });
  }, [available]);

  useEffect(() => {
    if (!anchor || !available) return;
    const stopObserving = observeMenuTarget(anchor.target, close);
    if (!anchor.waitingForRelease) return stopObserving;
    const document = anchor.target.ownerDocument;
    const release = (event: PointerEvent) => {
      if (event.button === 2) setAnchor({ ...anchor, waitingForRelease: false });
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', close, true);
    return () => {
      stopObserving();
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', close, true);
    };
  }, [anchor, available, close]);

  if (!available && anchor) setAnchor(null);

  return {
    onContextMenu,
    close,
    menu: anchor && !anchor.waitingForRelease && available ? (
      <Popover
        open
        onClose={close}
        trigger={null}
        anchorPoint={anchor}
        className={styles.menuPopover}
      >
        <MenuContent items={items} onSelect={onSelect} onClose={close} ariaLabel={ariaLabel} />
      </Popover>
    ) : null,
  };
}
