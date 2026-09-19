/**
 * ask_user answers live in renderer memory and follow the pending question identity.
 * Attachments use the same key but remain owned by the composer attachment store.
 */

import { useCallback, useMemo } from 'react';
import { create } from 'zustand';

import {
  clearAgentComposerDrafts,
  clearAllComposerDrafts,
  useComposerDraftStore,
} from './composer-drafts';

export interface QuestionItemDraft {
  readonly selected: readonly string[];
  readonly custom: string;
}

export const EMPTY_QUESTION_ITEM_DRAFT: QuestionItemDraft = Object.freeze({
  selected: Object.freeze([]),
  custom: '',
});

const EMPTY_QUESTION_DRAFT: readonly QuestionItemDraft[] = Object.freeze([]);
const QUESTION_KEY_PREFIX = 'question:';

export type QuestionDraftKey = `question:${string}:${string}`;
export type QuestionDraftUpdate = readonly QuestionItemDraft[]
  | ((current: readonly QuestionItemDraft[]) => readonly QuestionItemDraft[]);
export type QuestionItemDraftUpdate = QuestionItemDraft
  | ((current: QuestionItemDraft) => QuestionItemDraft);

export interface PendingQuestionIdentity {
  readonly agentId: string;
  readonly requestId: string;
}

export interface QuestionDraftStore {
  readonly drafts: Readonly<Record<string, readonly QuestionItemDraft[]>>;
  readonly versions: Readonly<Record<string, number>>;
  readonly setDraft: (key: QuestionDraftKey, update: QuestionDraftUpdate, version: number) => void;
  readonly setItem: (key: QuestionDraftKey, index: number, update: QuestionItemDraftUpdate, version: number) => void;
  readonly resetDraft: (key: QuestionDraftKey) => void;
}

function hasValue(item: QuestionItemDraft): boolean {
  return item.selected.length > 0 || item.custom !== '';
}

function copyItem(item: QuestionItemDraft): QuestionItemDraft {
  return hasValue(item) ? { selected: [...item.selected], custom: item.custom } : EMPTY_QUESTION_ITEM_DRAFT;
}

function compactDraft(items: readonly QuestionItemDraft[]): readonly QuestionItemDraft[] {
  let length = items.length;
  while (length > 0 && !hasValue(items[length - 1] ?? EMPTY_QUESTION_ITEM_DRAFT)) length -= 1;
  return length === 0 ? EMPTY_QUESTION_DRAFT : items.slice(0, length).map(copyItem);
}

function padDraft(
  items: readonly QuestionItemDraft[],
  itemCount: number,
): readonly QuestionItemDraft[] {
  if (items.length >= itemCount) return items;
  return [
    ...items,
    ...Array.from({ length: itemCount - items.length }, () => EMPTY_QUESTION_ITEM_DRAFT),
  ];
}

function writeDraft(
  state: QuestionDraftStore,
  key: QuestionDraftKey,
  items: readonly QuestionItemDraft[],
): Pick<QuestionDraftStore, 'drafts'> {
  const drafts = { ...state.drafts };
  const next = compactDraft(items);
  if (next.length === 0) delete drafts[key];
  else drafts[key] = next;
  return { drafts };
}

function resetQuestionState(keys: Iterable<QuestionDraftKey>): void {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  useQuestionDraftStore.setState((state) => {
    const drafts = { ...state.drafts };
    const versions = { ...state.versions };
    for (const key of unique) {
      delete drafts[key];
      versions[key] = (versions[key] ?? 0) + 1;
    }
    return { drafts, versions };
  });
}

export const useQuestionDraftStore = create<QuestionDraftStore>((set) => ({
  drafts: {},
  versions: {},

  setDraft: (key, update, version) => set((state) => {
    if ((state.versions[key] ?? 0) !== version) return state;
    const current = state.drafts[key] ?? EMPTY_QUESTION_DRAFT;
    return writeDraft(state, key, typeof update === 'function' ? update(current) : update);
  }),

  setItem: (key, index, update, version) => set((state) => {
    if ((state.versions[key] ?? 0) !== version) return state;
    const current = state.drafts[key] ?? EMPTY_QUESTION_DRAFT;
    const items = [...current];
    while (items.length <= index) items.push(EMPTY_QUESTION_ITEM_DRAFT);
    const item = items[index] ?? EMPTY_QUESTION_ITEM_DRAFT;
    items[index] = typeof update === 'function' ? update(item) : update;
    return writeDraft(state, key, items);
  }),

  resetDraft: (key) => {
    resetQuestionState([key]);
    useComposerDraftStore.getState().resetDraft(key);
  },
}));

export function questionDraftKey(agentId: string, requestId: string): QuestionDraftKey {
  return `question:${agentId}:${requestId}`;
}

export function getQuestionDraft(key: QuestionDraftKey): readonly QuestionItemDraft[] {
  return useQuestionDraftStore.getState().drafts[key] ?? EMPTY_QUESTION_DRAFT;
}

export function getQuestionDraftVersion(key: QuestionDraftKey): number {
  return useQuestionDraftStore.getState().versions[key] ?? 0;
}

export function useQuestionDraftVersion(key: QuestionDraftKey): number {
  return useQuestionDraftStore((state) => state.versions[key] ?? 0);
}

/** Whole-question draft API with the same functional-update shape as useState. */
export function useQuestionDraft(
  key: QuestionDraftKey,
  itemCount = 0,
): [readonly QuestionItemDraft[], (update: QuestionDraftUpdate) => void] {
  const stored = useQuestionDraftStore((state) => state.drafts[key] ?? EMPTY_QUESTION_DRAFT);
  const items = useMemo(() => padDraft(stored, itemCount), [itemCount, stored]);
  const setDraft = useQuestionDraftStore((state) => state.setDraft);
  const version = useQuestionDraftVersion(key);
  const setForKey = useCallback((update: QuestionDraftUpdate) => {
    setDraft(key, typeof update === 'function'
      ? (current) => update(padDraft(current, itemCount))
      : update, version);
  }, [itemCount, key, setDraft, version]);
  return [items, setForKey];
}

/** Single-item API for controls that should not rebuild the surrounding item array. */
export function useQuestionDraftItem(
  key: QuestionDraftKey,
  index: number,
): [QuestionItemDraft, (update: QuestionItemDraftUpdate) => void] {
  const item = useQuestionDraftStore(
    (state) => state.drafts[key]?.[index] ?? EMPTY_QUESTION_ITEM_DRAFT,
  );
  const setItem = useQuestionDraftStore((state) => state.setItem);
  const version = useQuestionDraftVersion(key);
  const setForItem = useCallback((update: QuestionItemDraftUpdate) => {
    setItem(key, index, update, version);
  }, [index, key, setItem, version]);
  return [item, setForItem];
}

export function resetQuestionDraft(key: QuestionDraftKey): void {
  useQuestionDraftStore.getState().resetDraft(key);
}

function isQuestionKey(key: string): key is QuestionDraftKey {
  return key.startsWith(QUESTION_KEY_PREFIX);
}

function activeQuestionKeys(): Set<QuestionDraftKey> {
  return new Set([
    ...Object.keys(useQuestionDraftStore.getState().drafts).filter(isQuestionKey),
    ...Object.keys(useComposerDraftStore.getState().drafts).filter(isQuestionKey),
  ]);
}

/** Keep exactly the pending question identities from the authoritative control snapshot. */
export function reconcileQuestionDrafts(pending: readonly PendingQuestionIdentity[]): void {
  const retained = new Set(pending.map(({ agentId, requestId }) => questionDraftKey(agentId, requestId)));
  for (const key of activeQuestionKeys()) {
    if (!retained.has(key)) useQuestionDraftStore.getState().resetDraft(key);
  }
}

export function clearAgentQuestionDrafts(agentId: string): void {
  const prefix = `${QUESTION_KEY_PREFIX}${agentId}:`;
  const question = useQuestionDraftStore.getState();
  const attachments = useComposerDraftStore.getState();
  const keys = new Set([
    ...Object.keys(question.drafts),
    ...Object.keys(question.versions),
    ...Object.keys(attachments.drafts),
    ...Object.keys(attachments.versions),
  ].filter((key): key is QuestionDraftKey => key.startsWith(prefix)));
  for (const key of keys) question.resetDraft(key);
}

export function clearAllQuestionDrafts(): void {
  const question = useQuestionDraftStore.getState();
  const attachments = useComposerDraftStore.getState();
  const keys = new Set([
    ...Object.keys(question.drafts),
    ...Object.keys(question.versions),
    ...Object.keys(attachments.drafts),
    ...Object.keys(attachments.versions),
  ].filter(isQuestionKey));
  for (const key of keys) question.resetDraft(key);
}

/** Lifecycle owner for permanent agent deletion. */
export function clearAgentConsoleDrafts(agentId: string): void {
  clearAgentComposerDrafts(agentId);
  clearAgentQuestionDrafts(agentId);
}

/** Lifecycle owner for renderer teardown without resetting question attachments twice. */
export function clearAllConsoleDrafts(): void {
  const keys = new Set([
    ...Object.keys(useQuestionDraftStore.getState().drafts),
    ...Object.keys(useQuestionDraftStore.getState().versions),
    ...Object.keys(useComposerDraftStore.getState().drafts),
    ...Object.keys(useComposerDraftStore.getState().versions),
  ].filter(isQuestionKey));
  clearAllComposerDrafts();
  resetQuestionState(keys);
}
