import React from 'react';

import { MenuButton, type MenuItemDescriptor } from '../MenuButton';
import { useContextMenu } from '../useContextMenu';

export type ExampleAction = 'open' | 'remove' | 'compact' | 'comfortable' | 'sort' | 'name' | 'recent';

const exampleItems: readonly MenuItemDescriptor<ExampleAction>[] = [
  { key: 'open', label: 'Open object' },
  { key: 'remove', label: 'Remove object', danger: true, disabled: true, disabledReason: 'Object is busy' },
  { key: 'compact', label: 'Compact view', separatorBefore: true, checked: true },
  { key: 'comfortable', label: 'Comfortable view', checked: false },
  { key: 'sort', label: 'Sort objects', separatorBefore: true, children: [
    { key: 'name', label: 'By name', checked: true },
    { key: 'recent', label: 'By recent activity', checked: false },
  ] },
];

interface TargetProps {
  readonly id: string;
  readonly items: readonly MenuItemDescriptor<string>[];
  readonly onSelect: (id: string, key: string) => void;
  readonly onObjectClick: (id: string) => void;
  readonly disabled?: boolean;
  readonly withButton?: boolean;
  readonly children?: React.ReactNode;
}

function Target({ id, items, onSelect, onObjectClick, disabled, withButton, children }: TargetProps) {
  const select = (key: string) => onSelect(id, key);
  const context = useContextMenu({ items, onSelect: select, ariaLabel: `${id} actions`, disabled });
  return (
    <>
      <div id={id} onContextMenu={context.onContextMenu} onClick={() => onObjectClick(id)}>
        <span id={`${id}-label`}>{id} object</span>
        {withButton && <MenuButton items={items} onSelect={select} ariaLabel={`${id} actions`} />}
        {children}
      </div>
      {context.menu}
    </>
  );
}

export interface MenuHarnessProps {
  readonly items?: readonly MenuItemDescriptor<string>[];
  readonly nestedItems?: readonly MenuItemDescriptor<string>[];
  readonly nestedDisabled?: boolean;
  readonly onSelect: TargetProps['onSelect'];
  readonly onObjectClick: TargetProps['onObjectClick'];
  readonly onRemoteContextMenu?: () => void;
}

export function MenuHarness({
  items = exampleItems,
  nestedItems = items,
  nestedDisabled,
  onSelect,
  onObjectClick,
  onRemoteContextMenu,
}: MenuHarnessProps) {
  return (
    <>
      <div id="scroller" style={{ maxHeight: 260, overflow: 'auto' }}>
        <div style={{ minHeight: 800 }}>
          <Target id="alpha" items={items} onSelect={onSelect} onObjectClick={onObjectClick} withButton>
            <input id="editor" aria-label="Edit object" />
            <textarea id="draft" aria-label="Draft text" />
            <span id="editable-title" contentEditable suppressContentEditableWarning>Editable title</span>
            <p id="body-selection">Selectable example text</p>
            <Target id="beta" items={nestedItems} disabled={nestedDisabled} onSelect={onSelect} onObjectClick={onObjectClick}>
              <span id="beta-child">Nested target</span>
            </Target>
          </Target>
          <Target id="gamma" items={items} onSelect={onSelect} onObjectClick={onObjectClick} />
        </div>
      </div>
      <div id="unregistered">Unregistered object</div>
      <div id="other-scroller" style={{ height: 30, overflow: 'auto' }}><div style={{ height: 200 }}>Other content</div></div>
      <div id="remote" onContextMenu={(event) => { event.preventDefault(); onRemoteContextMenu?.(); }}>Remote surface</div>
      <button id="outside" type="button">Outside</button>
    </>
  );
}
