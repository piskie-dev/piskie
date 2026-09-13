import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ComposerSkillOption } from '../../../../../shared/types/skill';

interface SkillQuery {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function queryAt(value: string, start: number, selectionStart: number, selectionEnd: number): SkillQuery | null {
  if (value[start] !== '/' || (start > 0 && !/\s/u.test(value[start - 1]!))) return null;
  const text = value.slice(start + 1).match(/^\S*/u)![0];
  const end = start + 1 + text.length;
  return selectionStart === selectionEnd && selectionStart > start && selectionStart <= end
    ? { start, end, text }
    : null;
}

/** Match the user's query directly against the original name and description. */
function searchSkills(options: readonly ComposerSkillOption[], query: string): readonly ComposerSkillOption[] {
  const term = query.toLowerCase();
  if (!term) return options;
  return options.map((option) => {
    const name = option.name.toLowerCase();
    const rank = name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2
      : option.description.toLowerCase().includes(term) ? 3 : -1;
    return { option, rank };
  }).filter(({ rank }) => rank >= 0).sort((a, b) => a.rank - b.rank).map(({ option }) => option);
}

const EMPTY_OPTIONS: readonly ComposerSkillOption[] = [];

interface SkillResult {
  readonly identity: string;
  readonly revision: number;
  readonly options: readonly ComposerSkillOption[];
  readonly error: string | null;
}

export interface SkillComposerInput {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly skills: readonly string[];
  readonly onSkillsChange: (skills: readonly string[]) => void;
  readonly workspace?: string;
  readonly draftIdentity: string;
  readonly enabled?: boolean;
}

export function useSkillComposer({ value, onChange, skills, onSkillsChange, workspace, draftIdentity, enabled = true }: SkillComposerInput) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const identity = `${draftIdentity}\0${workspace ?? ''}`;
  const [scope, setScope] = useState(identity);
  const [query, setQuery] = useState<SkillQuery | null>(null);
  const [result, setResult] = useState<SkillResult | null>(null);
  const optionsOwner = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const ignoreInput = useRef(false);
  const caretAfterSelection = useRef<number | null>(null);
  const listId = useId();
  if (scope !== identity) {
    setScope(identity);
    setQuery(null);
  }
  const open = enabled && query !== null && scope === identity;
  const hasSkills = skills.length > 0;
  const options = result?.identity === identity ? result.options : EMPTY_OPTIONS;
  const loading = enabled && (open || hasSkills) && (result?.identity !== identity || result.revision !== revision);
  const error = !loading && result?.identity === identity ? result.error : null;
  const close = useCallback(() => setQuery(null), []);
  const retry = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    // Restored tags also resolve their current source, while keeping the picker closed.
    if (!enabled || (!open && (!hasSkills || optionsOwner.current === identity))) return;
    let current = true;
    void window.piskie.capabilities.market.availableSkills(workspace).then((options) => {
      if (current) {
        optionsOwner.current = identity;
        setResult({ identity, revision, options, error: null });
        setHighlight(0);
      }
    }, (reason: unknown) => {
      if (current) {
        setResult({ identity, revision, options: EMPTY_OPTIONS, error: reason instanceof Error ? reason.message : String(reason) });
        setHighlight(0);
      }
    });
    return () => { current = false; };
  }, [enabled, hasSkills, identity, open, revision, workspace]);

  useEffect(() => {
    if (!open) return;
    return window.piskie.capabilities.market.observeChanges(retry);
  }, [open, retry]);

  const candidates = useMemo(() => searchSkills(options, query?.text ?? ''), [options, query?.text]);
  const selectable = loading || error !== null ? EMPTY_OPTIONS : candidates;
  const activeIndex = Math.min(highlight, selectable.length - 1);

  useEffect(() => {
    const caret = caretAfterSelection.current;
    if (caret === null) return;
    caretAfterSelection.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [value, query]);

  const select = useCallback((option: ComposerSkillOption) => {
    if (!query) return;
    if (!skills.includes(option.name)) onSkillsChange([...skills, option.name]);
    caretAfterSelection.current = query.start;
    onChange(value.slice(0, query.start) + value.slice(query.end));
    close();
  }, [close, onChange, onSkillsChange, query, skills, value]);

  const onInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const input = event.nativeEvent as InputEvent;
    const element = event.currentTarget;
    const pasted = ignoreInput.current;
    ignoreInput.current = false;
    // These edits update text without creating or extending a slash query.
    if (pasted || ['insertFromPaste', 'insertFromDrop', 'historyUndo', 'historyRedo'].includes(input.inputType)) {
      close();
      return;
    }
    const caret = element.selectionStart;
    setHighlight(0);
    if (enabled && input.inputType === 'insertText' && input.data === '/' && element.value[caret - 1] === '/') {
      const triggered = queryAt(element.value, caret - 1, caret, element.selectionEnd);
      if (triggered) {
        if (!open) retry();
        setQuery(triggered);
        return;
      }
    }
    setQuery((current) => current
      ? queryAt(element.value, current.start, caret, element.selectionEnd)
      : null);
  }, [close, enabled, open, retry]);

  const onSelect = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    setQuery((current) => current
      ? queryAt(element.value, current.start, element.selectionStart, element.selectionEnd)
      : null);
  }, []);

  const onPasteOrDrop = useCallback(() => {
    ignoreInput.current = true;
    close();
  }, [close]);

  /** Return true when the picker consumes the key, before the composer's send shortcuts. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    ignoreInput.current = false;
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'Tab' && activeIndex < 0) {
      close();
      return false;
    }
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter' || event.key === 'Tab') {
      const option = selectable[activeIndex];
      if (option) select(option);
    } else if (selectable.length > 0) {
      setHighlight((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + selectable.length) % selectable.length);
    }
    return true;
  }, [activeIndex, close, open, select, selectable]);

  return {
    textareaRef, anchorRef, open, options, candidates: selectable, loading, error, activeIndex,
    listId, close, retry, select, setHighlight, onKeyDown, onPasteOrDrop,
    textareaProps: {
      role: 'combobox',
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
      'aria-expanded': open,
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined,
      onInput,
      onSelect,
      onBlur: close,
      onDrop: onPasteOrDrop,
    },
  };
}

export type SkillComposerController = ReturnType<typeof useSkillComposer>;
