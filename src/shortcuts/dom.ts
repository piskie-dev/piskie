import { applicationShortcutRouter, type ShortcutRouter } from './router';
import type { ShortcutKeyEvent } from './types';

interface ListenerRecord {
  references: number;
  dispatch: (event: KeyboardEvent) => void;
  readonly listener: (event: KeyboardEvent) => void;
}

const LISTENERS_KEY = '__piskieApplicationShortcutListenersV1';
const globalHost = globalThis as Record<string, unknown>;
const listenerRecords =
  (globalHost[LISTENERS_KEY] as WeakMap<Window, ListenerRecord> | undefined)
  ?? (globalHost[LISTENERS_KEY] = new WeakMap<Window, ListenerRecord>()) as WeakMap<Window, ListenerRecord>;

interface ElementLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as ElementLike;
  const tagName = element.tagName?.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  if (element.isContentEditable) return true;
  return typeof element.closest === 'function'
    && element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export function shortcutEventFromKeyboardEvent(event: KeyboardEvent): ShortcutKeyEvent {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    defaultPrevented: event.defaultPrevented,
    isComposing: event.isComposing,
    editableTarget: isEditableTarget(event.target),
    repeat: event.repeat,
    preventDefault: () => event.preventDefault(),
  };
}

function hasUnmanagedNativeOverlay(event: KeyboardEvent): boolean {
  const target = event.target as { readonly ownerDocument?: Document } | null;
  const document = target?.ownerDocument ?? (event.currentTarget as Window | null)?.document;
  if (!document) return false;
  if (document.querySelector('dialog[open]')) return true;
  try {
    return document.querySelector('[popover="auto"]:popover-open') !== null;
  } catch {
    return false;
  }
}

/** Installs one physical bubbling listener per Window, including across HMR. */
export function mountShortcutListener(
  target: Window = window,
  router: ShortcutRouter = applicationShortcutRouter,
): () => void {
  let record = listenerRecords.get(target);
  const dispatch = (event: KeyboardEvent): void => {
    if (event.key === 'Escape'
      && !router.hasActiveOverlay()
      && hasUnmanagedNativeOverlay(event)) return;
    router.dispatch(shortcutEventFromKeyboardEvent(event));
  };

  if (record) {
    record.references += 1;
    record.dispatch = dispatch;
  } else {
    const created: ListenerRecord = {
      references: 1,
      dispatch,
      listener: (event) => created.dispatch(event),
    };
    record = created;
    listenerRecords.set(target, created);
    target.addEventListener('keydown', created.listener);
  }

  const mountedRecord = record;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    mountedRecord.references -= 1;
    if (mountedRecord.references > 0 || listenerRecords.get(target) !== mountedRecord) return;
    target.removeEventListener('keydown', mountedRecord.listener);
    listenerRecords.delete(target);
  };
}
