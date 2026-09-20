import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useComposerDraftStore } from '../../data/composer-drafts';
import { textareaVisualLine } from './textareaVisualLine';

const EMPTY_HISTORY: readonly string[] = Object.freeze([]);

interface ComposerHistoryOptions {
  readonly draftKey: string;
  readonly draftIdentity: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

interface ComposerHistoryController {
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly resetNavigation: () => void;
}

/** Navigates successful text submissions without taking over multiline cursor movement. */
export function useComposerHistory({
  draftKey,
  draftIdentity,
  value,
  onChange,
}: ComposerHistoryOptions): ComposerHistoryController {
  const history = useComposerDraftStore((state) => state.histories[draftKey] ?? EMPTY_HISTORY);
  const cursor = useRef<number | null>(null);
  const pendingDraft = useRef('');
  const lastNavigatedValue = useRef<string | null>(null);

  const resetNavigation = useCallback(() => {
    cursor.current = null;
    pendingDraft.current = '';
    lastNavigatedValue.current = null;
  }, []);

  useEffect(() => resetNavigation(), [draftIdentity, history, resetNavigation]);
  useEffect(() => {
    if (cursor.current !== null && lastNavigatedValue.current !== value) resetNavigation();
  }, [resetNavigation, value]);

  const change = useCallback((next: string) => {
    resetNavigation();
    onChange(next);
  }, [onChange, resetNavigation]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      if (cursor.current !== null) resetNavigation();
      return false;
    }

    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
      resetNavigation();
      return false;
    }

    let next: string;
    if (event.key === 'ArrowUp') {
      if (history.length === 0) return false;
      if (!textareaVisualLine(event.currentTarget).first) return false;
      if (cursor.current === null) {
        pendingDraft.current = value;
        cursor.current = history.length - 1;
      } else {
        cursor.current = Math.max(0, cursor.current - 1);
      }
      next = history[cursor.current]!;
    } else {
      if (cursor.current === null) return false;
      if (!textareaVisualLine(event.currentTarget).last) return false;
      if (cursor.current >= history.length - 1) {
        next = pendingDraft.current;
        cursor.current = null;
      } else {
        cursor.current += 1;
        next = history[cursor.current]!;
      }
    }

    event.preventDefault();
    lastNavigatedValue.current = next;
    onChange(next);

    const textarea = event.currentTarget;
    queueMicrotask(() => {
      if (textarea.isConnected && textarea.value === next) {
        textarea.setSelectionRange(next.length, next.length);
      }
    });
    return true;
  }, [history, onChange, resetNavigation, value]);

  return { onChange: change, onKeyDown, resetNavigation };
}
