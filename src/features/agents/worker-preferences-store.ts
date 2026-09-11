import { create } from 'zustand';
import type { ConfigDescriptor } from '../../../shared/types/config';
import type {
  WorkerPreferencesDocument,
  WorkerTypeDescriptor,
} from '../../../shared/types/worker-preferences';
import { applyConfigFieldChanges } from '../config/config-transaction';
import {
  fromProfile,
  preferenceMutations,
  reconcileDrafts,
  sameValue,
  type InferenceDraft,
  type WorkerDraft,
} from './worker-preference-drafts';

interface State {
  document: WorkerPreferencesDocument | null;
  descriptor: ConfigDescriptor | null;
  types: WorkerTypeDescriptor[];
  drafts: Record<string, WorkerDraft>;
  selected: string;
  scrollPositions: Record<string, number>;
  rememberScroll: (type: string, top: number) => void;
  loading: boolean;
  saving: string | null;
  loadError: string | null;
  saveErrors: Record<string, string>;
  savedType: string | null;
  refresh: () => Promise<void>;
  select: (type: string) => void;
  edit: (type: string, value: InferenceDraft) => void;
  editDisplayName: (type: string, displayName: string) => void;
  discard: (type: string) => void;
  rebase: (type: string) => void;
  save: (type: string) => Promise<void>;
}
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
let refreshTail: Promise<void> = Promise.resolve();
export const useWorkerPreferencesStore = create<State>((set, get) => ({
  document: null,
  descriptor: null,
  types: [],
  drafts: {},
  selected: '',
  scrollPositions: {},
  rememberScroll: (type, top) =>
    set((state) =>
      state.scrollPositions[type] === top
        ? state
        : { scrollPositions: { ...state.scrollPositions, [type]: top } }
    ),
  loading: false,
  saving: null,
  loadError: null,
  saveErrors: {},
  savedType: null,
  refresh: () => {
    // Queue refreshes so an event arriving during a read cannot be lost.
    const task = refreshTail.then(async () => {
      set({ loading: true });
      try {
        const [document, descriptor, types] = await Promise.all([
          window.piskie.configuration.read<WorkerPreferencesDocument>('worker-preferences'),
          window.piskie.configuration.describe('worker-preferences'),
          window.piskie.agents.listWorkerTypes(),
        ]);
        set((state) => ({
          document,
          descriptor,
          types,
          loadError: null,
          drafts: reconcileDrafts(state.drafts, document.profiles),
          selected:
            types.some((entry) => entry.type === state.selected) ||
            document.profiles[state.selected]
              ? state.selected
              : (types[0]?.type ?? Object.keys(document.profiles)[0] ?? ''),
        }));
      } catch (error) {
        set({ loadError: errorText(error) });
      } finally {
        set({ loading: false });
      }
    });
    refreshTail = task;
    return task;
  },
  select: (selected) => set({ selected, savedType: null }),
  edit: (type, value) => set((state) => editDraft(state, type, { value })),
  editDisplayName: (type, displayName) => set((state) => editDraft(state, type, { displayName })),
  discard: (type) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[type];
      const saveErrors = { ...state.saveErrors };
      delete saveErrors[type];
      return { drafts, saveErrors, savedType: null };
    }),
  rebase: (type) =>
    set((state) => {
      const draft = state.drafts[type];
      if (!draft) return state;
      const latest = state.document?.profiles[type];
      return {
        drafts: {
          ...state.drafts,
          [type]: {
            ...draft,
            value: sameValue(draft.value, fromProfile(draft.base))
              ? fromProfile(latest)
              : draft.value,
            displayName:
              draft.displayName.trim() === (draft.base?.displayName ?? '')
                ? (latest?.displayName ?? '')
                : draft.displayName,
            base: structuredClone(latest),
            conflict: false,
          },
        },
      };
    }),
  save: async (type) => {
    if (get().saving) return;
    set({ saving: type, savedType: null });
    try {
      await get().refresh();
      const { document, descriptor, drafts, loadError } = get();
      const draft = drafts[type];
      if (loadError) throw new Error(loadError);
      if (!document || !descriptor || !draft || draft.conflict) return;
      const changes = preferenceMutations(type, document.profiles[type], draft);
      if (changes.length)
        await applyConfigFieldChanges('worker-preferences', descriptor, document.revision, changes);
      await get().refresh();
      if (get().loadError) throw new Error(get().loadError!);
      set((state) => {
        const saveErrors = { ...state.saveErrors };
        delete saveErrors[type];
        return { savedType: state.drafts[type] ? null : type, saveErrors };
      });
    } catch (error) {
      set((state) => ({ saveErrors: { ...state.saveErrors, [type]: errorText(error) } }));
      await get().refresh();
    } finally {
      set({ saving: null });
    }
  },
}));

function editDraft(
  state: State,
  type: string,
  updates: Partial<Pick<WorkerDraft, 'value' | 'displayName'>>
): Partial<State> {
  if (state.saving || !state.document) return state;
  const base = state.document.profiles[type];
  const draft: WorkerDraft = {
    ...(state.drafts[type] ?? {
      base: structuredClone(base),
      value: fromProfile(base),
      displayName: base?.displayName ?? '',
      conflict: false,
    }),
    ...updates,
  };
  const drafts = { ...state.drafts };
  if (
    !draft.conflict &&
    sameValue(draft.value, fromProfile(base)) &&
    draft.displayName.trim() === (base?.displayName ?? '')
  )
    delete drafts[type];
  else drafts[type] = draft;
  const saveErrors = { ...state.saveErrors };
  delete saveErrors[type];
  return { drafts, saveErrors, savedType: null };
}
