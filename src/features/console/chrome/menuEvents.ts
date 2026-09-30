import type React from 'react';

/** Leave editing and selected text to the browser's context menu. */
export function canOpenContextMenu(event: React.MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 2) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return false;
  const editable = target.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return false;

  const selection = target.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (selection.getRangeAt(index).intersectsNode(target)) return false;
    }
  }
  return true;
}

/** Subscribe only while a menu is open; menu scrolling is not target scrolling. */
export function observeMenuTarget(target: Element, onClose: () => void): () => void {
  const ancestors: Element[] = [];
  for (let element: Element | null = target; element; element = element.parentElement) {
    ancestors.push(element);
    element.addEventListener('scroll', onClose);
  }
  const document = target.ownerDocument;
  document.addEventListener('scroll', onClose);
  document.addEventListener('dragstart', onClose, true);
  return () => {
    for (const element of ancestors) element.removeEventListener('scroll', onClose);
    document.removeEventListener('scroll', onClose);
    document.removeEventListener('dragstart', onClose, true);
  };
}
