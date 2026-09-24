import { create } from 'zustand';
import type { ConfigDescriptor } from '../../../shared/types/config';
import type {
  WorkerPreferences,
  WorkerPreferencesDocument,
  WorkerTypeDescriptor,
} from '../../../shared/types/worker-preferences';
import type { ModelOptGroup } from '../../store/inferenceStore';
import { applyConfigFieldChanges } from '../config/config-transaction';
import {
  draftProblem,
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
  configureAutosave: (groups: ModelOptGroup[], modelError: string | null) => void;
}
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const typePriority = new Map([
  ['local-worker', 0],
  ['browser-worker', 1],
  ['explore', 2],
]);
let refreshTail: Promise<void> = Promise.resolve();
let autosaveContext: { groups: ModelOptGroup[]; modelError: string | null } | null = null;
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let pendingWrite: { type: string; profile?: WorkerPreferences } | undefined;

function expectedProfile(
  profile: WorkerPreferences | undefined,
  draft: WorkerDraft
): WorkerPreferences | undefined {
  if (draft.value.mode === 'remove') return undefined;
  const next = { ...profile };
  if (draft.displayName.trim()) next.displayName = draft.displayName.trim();
  else delete next.displayName;
  if (draft.value.mode === 'inherit') delete next.inference;
  else if (draft.value.target && draft.value.reasoning)
    next.inference = { target: draft.value.target, reasoning: draft.value.reasoning };
  return Object.keys(next).length ? next : undefined;
}

function eligibleForAutosave(state: State, type: string): boolean {
  const draft = state.drafts[type];
  if (
    !autosaveContext || !state.document || !state.descriptor || state.loading || state.saving ||
    state.loadError || state.saveErrors[type] || !draft || draft.conflict
  ) return false;
  const inferenceChanged = !sameValue(draft.value, fromProfile(state.document.profiles[type]));
  return !inferenceChanged || draft.value.mode !== 'fixed' ||
    (!autosaveContext.modelError && !draftProblem(draft.value, autosaveContext.groups));
}

function scheduleAutosave(type: string): void {
  clearTimeout(autosaveTimers.get(type));
  autosaveTimers.delete(type);
  if (!eligibleForAutosave(useWorkerPreferencesStore.getState(), type)) return;
  autosaveTimers.set(type, setTimeout(() => {
    autosaveTimers.delete(type);
    if (eligibleForAutosave(useWorkerPreferencesStore.getState(), type))
      void useWorkerPreferencesStore.getState().save(type);
  }, 350));
}

function schedulePendingAutosaves(): void {
  for (const type of Object.keys(useWorkerPreferencesStore.getState().drafts)) scheduleAutosave(type);
}

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
        const [document, descriptor, availableTypes] = await Promise.all([
          window.piskie.configuration.read<WorkerPreferencesDocument>('worker-preferences'),
          window.piskie.configuration.describe('worker-preferences'),
          window.piskie.agents.listWorkerTypes(),
        ]);
        const types = [...availableTypes].sort(
          (left, right) =>
            (typePriority.get(left.type) ?? typePriority.size) -
            (typePriority.get(right.type) ?? typePriority.size)
        );
        set((state) => ({
          document,
          descriptor,
          types,
          loadError: null,
          drafts: reconcileDrafts(state.drafts, document.profiles, pendingWrite),
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
        schedulePendingAutosaves();
      }
    });
    refreshTail = task;
    return task;
  },
  select: (selected) => set({ selected, savedType: null }),
  edit: (type, value) => {
    set((state) => editDraft(state, type, { value }));
    scheduleAutosave(type);
  },
  editDisplayName: (type, displayName) => {
    set((state) => editDraft(state, type, { displayName }));
    scheduleAutosave(type);
  },
  discard: (type) =>
    set((state) => {
      clearTimeout(autosaveTimers.get(type));
      autosaveTimers.delete(type);
      const drafts = { ...state.drafts };
      delete drafts[type];
      const saveErrors = { ...state.saveErrors };
      delete saveErrors[type];
      return { drafts, saveErrors, savedType: null };
    }),
  rebase: (type) => {
    set((state) => {
      const draft = state.drafts[type];
      if (!draft) return state;
      const latest = state.document?.profiles[type];
      const saveErrors = { ...state.saveErrors };
      delete saveErrors[type];
      return {
        saveErrors,
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
    });
    scheduleAutosave(type);
  },
  configureAutosave: (groups, modelError) => {
    autosaveContext = { groups, modelError };
    schedulePendingAutosaves();
  },
  save: async (type) => {
    if (get().saving) return;
    set({ saving: type, savedType: null });
    try {
      await get().refresh();
      const { document, descriptor, drafts, loadError } = get();
      const draft = drafts[type];
      if (loadError) throw new Error(loadError);
      if (!document || !descriptor || !draft || draft.conflict) return;
      if (autosaveContext) {
        const inferenceChanged = !sameValue(draft.value, fromProfile(document.profiles[type]));
        if (
          inferenceChanged && draft.value.mode === 'fixed' &&
          (autosaveContext.modelError || draftProblem(draft.value, autosaveContext.groups))
        ) return;
      }
      const changes = preferenceMutations(type, document.profiles[type], draft);
      if (changes.length) {
        pendingWrite = { type, profile: expectedProfile(document.profiles[type], draft) };
        await applyConfigFieldChanges('worker-preferences', descriptor, document.revision, changes);
      }
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
      pendingWrite = undefined;
      set({ saving: null });
      schedulePendingAutosaves();
    }
  },
}));

function editDraft(
  state: State,
  type: string,
  updates: Partial<Pick<WorkerDraft, 'value' | 'displayName'>>
): Partial<State> {
  if (!state.document) return state;
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
    state.saving !== type &&
    sameValue(draft.value, fromProfile(base)) &&
    draft.displayName.trim() === (base?.displayName ?? '')
  )
    delete drafts[type];
  else drafts[type] = draft;
  const saveErrors = { ...state.saveErrors };
  delete saveErrors[type];
  return { drafts, saveErrors, savedType: null };
}
