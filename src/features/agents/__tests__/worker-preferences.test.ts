import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPreferencesDocument } from '../../../../shared/types/worker-preferences';
import type { ModelOptGroup } from '../../../store/inferenceStore';
import {
  chooseModel,
  draftProblem,
  fromProfile,
  inferenceMutations,
  preferenceMutations,
} from '../worker-preference-drafts';
import { useWorkerPreferencesStore as store } from '../worker-preferences-store';
import { applyConfigFieldChanges } from '../../config/config-transaction';
vi.mock('../../config/config-transaction', () => ({ applyConfigFieldChanges: vi.fn() }));
const preference = {
  inference: {
    target: { providerId: 'p', modelId: 'model' },
    reasoning: { kind: 'effort', effort: 'high' },
  },
} as const;
const option = {
  value: 'p::model',
  label: 'Model',
  target: preference.inference.target,
  definition: {
    reasoning: {
      mode: 'effort',
      options: [
        { kind: 'effort', effort: 'low' },
        { kind: 'effort', effort: 'high' },
      ],
      defaultSelection: { kind: 'effort', effort: 'low' },
    },
  },
  defaultReasoning: { kind: 'effort', effort: 'high' },
} as ModelOptGroup['options'][number];
let disk: WorkerPreferencesDocument;
beforeEach(() => {
  disk = { schemaVersion: 1, revision: 0, profiles: { explore: structuredClone(preference) } };
  store.setState({
    document: null,
    descriptor: null,
    types: [],
    drafts: {},
    selected: '',
    loading: false,
    saving: null,
    loadError: null,
    saveErrors: {},
    savedType: null,
  });
  vi.stubGlobal('window', {
    piskie: {
      configuration: {
        read: async () => structuredClone(disk),
        describe: async () => ({ domain: 'worker-preferences' }),
      },
      agents: {
        listWorkerTypes: async () => [
          { type: 'explore', description: 'Explore' },
          { type: 'other', description: 'Other' },
        ],
      },
    },
  });
  vi.mocked(applyConfigFieldChanges)
    .mockReset()
    .mockImplementation(async (_domain, _descriptor, revision, changes) => {
      expect(revision).toBe(disk.revision);
      for (const change of changes) {
        const type = change.bindings!.type as string;
        if (change.pathTemplate.endsWith('/inference')) {
          if (change.op === 'remove') delete disk.profiles[type]!.inference;
          else
            disk.profiles[type] = {
              ...disk.profiles[type],
              inference: change.value as typeof preference.inference,
            };
        } else if (change.pathTemplate.endsWith('/displayName')) {
          if (change.op === 'remove') delete disk.profiles[type]!.displayName;
          else
            disk.profiles[type] = { ...disk.profiles[type], displayName: change.value as string };
        } else if (change.op === 'remove') delete disk.profiles[type];
        else disk.profiles[type] = change.value as typeof preference;
      }
      disk.revision++;
      return { receipt: { revision: disk.revision } } as Awaited<
        ReturnType<typeof applyConfigFieldChanges>
      >;
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('Agent preference drafts', () => {
  it('saves and clears remarks independently from inference while retaining the type key', async () => {
    await store.getState().refresh();
    store.getState().editDisplayName('explore', '  Code review  ');
    store.getState().select('other');
    await store.getState().save('explore');
    expect(disk.profiles.explore).toEqual({ ...preference, displayName: 'Code review' });
    expect(disk.profiles['Code review']).toBeUndefined();
    store.getState().edit('explore', { mode: 'inherit' });
    await store.getState().save('explore');
    expect(disk.profiles.explore).toEqual({ displayName: 'Code review' });
    store.getState().editDisplayName('explore', '');
    await store.getState().save('explore');
    expect(disk.profiles.explore).toBeUndefined();
  });

  it('saves a remark and model together and keeps the model when clearing the remark', async () => {
    await store.getState().refresh();
    store.getState().editDisplayName('other', 'Review');
    store.getState().edit('other', fromProfile(preference));
    await store.getState().save('other');
    expect(disk.profiles.other).toEqual({ ...preference, displayName: 'Review' });
    store.getState().editDisplayName('other', '');
    await store.getState().save('other');
    expect(disk.profiles.other).toEqual(preference);
    expect(disk.profiles.explore).toEqual(preference);
    // A profile containing only a remark must survive adding inference while clearing its remark.
    expect(
      preferenceMutations(
        'other',
        { displayName: 'Review' },
        {
          base: { displayName: 'Review' },
          displayName: '',
          value: fromProfile(preference),
          conflict: false,
        }
      )
    ).toEqual([
      { op: 'remove', pathTemplate: '/profiles/{type}/displayName', bindings: { type: 'other' } },
      {
        op: 'set',
        pathTemplate: '/profiles/{type}/inference',
        bindings: { type: 'other' },
        value: preference.inference,
      },
    ]);
  });

  it('retains remarks on save failure and keeps externally updated inference when resolving a remark conflict', async () => {
    await store.getState().refresh();
    store.getState().editDisplayName('explore', 'My note');
    disk.profiles.explore = {
      inference: { ...preference.inference, reasoning: { kind: 'effort', effort: 'low' } },
    };
    disk.revision++;
    await store.getState().save('explore');
    expect(store.getState().drafts.explore?.conflict).toBe(true);
    store.getState().rebase('explore');
    vi.mocked(applyConfigFieldChanges).mockRejectedValueOnce(new Error('Write failed'));
    await store.getState().save('explore');
    expect(store.getState().drafts.explore?.displayName).toBe('My note');
    await store.getState().save('explore');
    expect(disk.profiles.explore).toEqual({
      displayName: 'My note',
      inference: { ...preference.inference, reasoning: { kind: 'effort', effort: 'low' } },
    });
  });

  it('uses the configured default only when choosing a different model', () => {
    const selected = chooseModel({ mode: 'inherit' }, option);
    expect(selected).toMatchObject({ reasoning: { kind: 'effort', effort: 'high' } });
    const edited = {
      ...selected,
      mode: 'fixed' as const,
      reasoning: { kind: 'effort' as const, effort: 'low' as const },
    };
    expect(chooseModel(edited, option)).toBe(edited);
    expect(fromProfile(preference)).toMatchObject({
      reasoning: { kind: 'effort', effort: 'high' },
    });
    expect(
      chooseModel(edited, {
        ...option,
        value: 'p::second',
        target: { providerId: 'p', modelId: 'second' },
      })
    ).toMatchObject({ reasoning: { kind: 'effort', effort: 'high' } });
  });
  it('matches model settings for legacy off defaults without rewriting existing Agent selections', () => {
    const legacy = {
      ...option,
      defaultReasoning: { kind: 'disabled' as const },
      definition: {
        ...option.definition,
        reasoning: {
          ...option.definition.reasoning!,
          options: [{ kind: 'disabled' as const }, ...option.definition.reasoning!.options],
        },
      },
    };
    expect(chooseModel({ mode: 'fixed' }, legacy)).toMatchObject({
      reasoning: { kind: 'effort', effort: 'low' },
    });
    const saved = {
      inference: { target: option.target, reasoning: { kind: 'disabled' as const } },
    };
    const existing = fromProfile(saved);
    expect(chooseModel(existing, legacy)).toBe(existing);
    expect(existing).toMatchObject({ reasoning: { kind: 'disabled' } });
  });
  it('distinguishes empty drafts, unavailable targets and invalid reasoning', () => {
    expect(draftProblem({ mode: 'fixed' }, [])).toBe('chooseModel');
    expect(draftProblem(fromProfile(preference), [])).toBe('modelUnavailable');
    expect(
      draftProblem(fromProfile(preference), [{ label: 'Provider', options: [option] }])
    ).toBeUndefined();
    expect(
      draftProblem(
        { mode: 'fixed', target: option.target, reasoning: { kind: 'effort', effort: 'max' } },
        [{ label: 'Provider', options: [option] }]
      )
    ).toBe('reasoningInvalid');
    expect(
      inferenceMutations('explore', { ...preference, futureSection: {} } as typeof preference, {
        mode: 'inherit',
      })
    ).toEqual([
      { op: 'remove', pathTemplate: '/profiles/{type}/inference', bindings: { type: 'explore' } },
    ]);
  });
  it('preserves drafts across switches and saves only the current type at the latest unrelated revision', async () => {
    await store.getState().refresh();
    store.getState().edit('explore', { mode: 'inherit' });
    store.getState().select('other');
    store.getState().edit('other', fromProfile(preference));
    disk.profiles.external = preference;
    disk.revision++;
    await store.getState().save('other');
    expect(disk.profiles).toMatchObject({
      explore: preference,
      other: preference,
      external: preference,
    });
    expect(store.getState().drafts.explore?.value).toEqual({ mode: 'inherit' });
    expect(store.getState().drafts.other).toBeUndefined();
    expect(store.getState().savedType).toBe('other');
  });
  it('requires explicit resolution when the edited type changes elsewhere and retains failed saves', async () => {
    await store.getState().refresh();
    store.getState().edit('explore', { mode: 'inherit' });
    disk.profiles.explore = {
      inference: { ...preference.inference, reasoning: { kind: 'effort', effort: 'low' } },
    };
    disk.revision++;
    await store.getState().save('explore');
    expect(applyConfigFieldChanges).not.toHaveBeenCalled();
    expect(store.getState().drafts.explore).toMatchObject({
      value: { mode: 'inherit' },
      conflict: true,
    });
    store.getState().rebase('explore');
    vi.mocked(applyConfigFieldChanges).mockRejectedValueOnce(new Error('Disk write failed'));
    await store.getState().save('explore');
    expect(store.getState().drafts.explore?.value).toEqual({ mode: 'inherit' });
    expect(store.getState().saveErrors.explore).toBe('Disk write failed');
    await store.getState().save('explore');
    expect(disk.profiles.explore).toBeUndefined();
    expect(store.getState().drafts.explore).toBeUndefined();
  });
});
