/**
 * 输入草稿按投递目标驻留在 renderer 内存中。文字、附件与新会话选项共同保留，
 * 页面切换不改变草稿；显式新建或发送成功时整体重置。
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import type { ApprovalMode } from '../../../../shared/types';

import type {
  AttachmentFile,
  AttachmentImage,
  ImagePayload,
} from '../attachments/model';

export type ComposerAttachmentImageResource =
  | {
      readonly kind: 'blob';
      readonly blob: Blob;
      readonly sourcePath?: string;
      readonly objectUrl: string;
      encoded?: Promise<ImagePayload>;
    }
  | {
      readonly kind: 'url';
      readonly url: string;
      readonly sourcePath: string;
      encoded?: Promise<ImagePayload>;
    };

export interface ComposerAttachmentState {
  readonly images: readonly AttachmentImage[];
  readonly files: readonly AttachmentFile[];
  readonly imageResources: ReadonlyMap<string, ComposerAttachmentImageResource>;
}

export const WELCOME_DRAFT_KEY = 'welcome';

/** 新增输入区选项在这里声明默认值，并通过 patchSettings 更新，即可共享保留/重置规则。 */
export interface ComposerDraftSettings {
  readonly model: string | undefined;
  readonly modeId: 'normal' | 'plan' | 'browser-skill';
  readonly approvalMode: ApprovalMode;
  readonly workspace: string | undefined;
  readonly environmentIds: readonly string[];
}

export const DEFAULT_COMPOSER_SETTINGS: ComposerDraftSettings = Object.freeze({
  model: undefined,
  modeId: 'normal',
  approvalMode: 'confirm',
  workspace: undefined,
  environmentIds: Object.freeze([]),
});

interface ComposerDraftValue {
  readonly text: string;
  readonly attachments: ComposerAttachmentState;
  /** 已有会话的运行设置由会话 owner 提供，只有待创建会话在草稿中保存设置。 */
  readonly settings?: ComposerDraftSettings;
}

interface ComposerImageAddition {
  readonly image: AttachmentImage;
  readonly resource: ComposerAttachmentImageResource;
}

const EMPTY_ATTACHMENTS: ComposerAttachmentState = Object.freeze({
  images: Object.freeze([]),
  files: Object.freeze([]),
  imageResources: new Map(),
});

function emptyDraft(): ComposerDraftValue {
  return { text: '', attachments: EMPTY_ATTACHMENTS };
}

function hasAttachments(attachments: ComposerAttachmentState): boolean {
  return attachments.images.length > 0 || attachments.files.length > 0;
}

function disposeImageResource(resource: ComposerAttachmentImageResource | undefined): void {
  if (resource?.kind === 'blob') URL.revokeObjectURL(resource.objectUrl);
}

function disposeImageResources(resources: ReadonlyMap<string, ComposerAttachmentImageResource>): void {
  for (const resource of resources.values()) disposeImageResource(resource);
}

export interface ComposerDraftStore {
  readonly drafts: Readonly<Record<string, ComposerDraftValue>>;
  readonly versions: Readonly<Record<string, number>>;
  /** 只记录页面审批控件的主动选择，驻留内存，软件重启后恢复 confirm。 */
  readonly defaults: ComposerDraftSettings;
  readonly selectApprovalMode: (mode: ApprovalMode) => void;
  readonly patchSettings: (key: string, patch: Partial<ComposerDraftSettings>, version: number) => void;
  readonly resetDraft: (key: string, settings?: Partial<ComposerDraftSettings>) => void;
  readonly setDraft: (key: string, text: string) => void;
  readonly appendImages: (key: string, additions: readonly ComposerImageAddition[]) => void;
  readonly appendFiles: (key: string, additions: readonly AttachmentFile[]) => void;
  readonly removeAttachment: (key: string, id: string) => void;
  readonly clearAttachments: (key: string) => void;
}

export const useComposerDraftStore = create<ComposerDraftStore>((set) => ({
  drafts: {},
  versions: {},
  defaults: DEFAULT_COMPOSER_SETTINGS,

  selectApprovalMode: (approvalMode) => set((state) => ({
    defaults: { ...state.defaults, approvalMode },
  })),

  patchSettings: (key, patch, version) => set((state) => {
    if ((state.versions[key] ?? 0) !== version) return state;
    const current = state.drafts[key] ?? emptyDraft();
    return {
      drafts: {
        ...state.drafts,
        [key]: { ...current, settings: { ...(current.settings ?? state.defaults), ...patch } },
      },
    };
  }),

  resetDraft: (key, settings) => set((state) => {
    const current = state.drafts[key];
    if (current) disposeImageResources(current.attachments.imageResources);
    const drafts = { ...state.drafts };
    if (settings) {
      drafts[key] = { ...emptyDraft(), settings: { ...state.defaults, ...settings } };
    } else {
      delete drafts[key];
    }
    return { drafts, versions: { ...state.versions, [key]: (state.versions[key] ?? 0) + 1 } };
  }),

  setDraft: (key, text) => set((state) => {
    const current = state.drafts[key] ?? emptyDraft();
    if (current.text === text) return state;

    const drafts = { ...state.drafts };
    if (text === '' && !hasAttachments(current.attachments) && !current.settings) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, text };
    }
    return { drafts };
  }),

  appendImages: (key, additions) => set((state) => {
    if (additions.length === 0) return state;
    const current = state.drafts[key] ?? emptyDraft();
    const imageResources = new Map(current.attachments.imageResources);
    for (const addition of additions) imageResources.set(addition.image.id, addition.resource);
    return {
      drafts: {
        ...state.drafts,
        [key]: {
          ...current,
          attachments: {
            ...current.attachments,
            images: [...current.attachments.images, ...additions.map(({ image }) => image)],
            imageResources,
          },
        },
      },
    };
  }),

  appendFiles: (key, additions) => set((state) => {
    if (additions.length === 0) return state;
    const current = state.drafts[key] ?? emptyDraft();
    return {
      drafts: {
        ...state.drafts,
        [key]: {
          ...current,
          attachments: {
            ...current.attachments,
            files: [...current.attachments.files, ...additions],
          },
        },
      },
    };
  }),

  removeAttachment: (key, id) => set((state) => {
    const current = state.drafts[key];
    if (!current) return state;

    const resource = current.attachments.imageResources.get(id);
    const images = current.attachments.images.filter((image) => image.id !== id);
    const files = current.attachments.files.filter((file) => file.id !== id);
    if (!resource && images.length === current.attachments.images.length && files.length === current.attachments.files.length) {
      return state;
    }

    disposeImageResource(resource);
    const imageResources = new Map(current.attachments.imageResources);
    imageResources.delete(id);
    const attachments = { images, files, imageResources };
    const drafts = { ...state.drafts };
    if (current.text === '' && !hasAttachments(attachments) && !current.settings) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, attachments };
    }
    return { drafts };
  }),

  clearAttachments: (key) => set((state) => {
    const current = state.drafts[key];
    if (current) disposeImageResources(current.attachments.imageResources);

    const drafts = { ...state.drafts };
    if (!current || (current.text === '' && !current.settings)) {
      delete drafts[key];
    } else {
      drafts[key] = { ...current, attachments: EMPTY_ATTACHMENTS };
    }
    return {
      drafts,
    };
  }),
}));

/** 目标键的受控文字草稿，形如 useState。 */
export function useComposerDraft(key: string): [string, (text: string) => void] {
  const value = useComposerDraftStore((state) => state.drafts[key]?.text ?? '');
  const setDraft = useComposerDraftStore((state) => state.setDraft);
  const version = useComposerDraftVersion(key);
  const setForKey = useCallback((text: string) => {
    if (getComposerDraftVersion(key) === version) setDraft(key, text);
  }, [key, setDraft, version]);
  return [value, setForKey];
}

export function useComposerDraftSettings(key: string): [ComposerDraftSettings, (patch: Partial<ComposerDraftSettings>) => void] {
  const settings = useComposerDraftStore((state) => state.drafts[key]?.settings ?? state.defaults);
  const patchSettings = useComposerDraftStore((state) => state.patchSettings);
  const version = useComposerDraftVersion(key);
  const patchForKey = useCallback((patch: Partial<ComposerDraftSettings>) => {
    patchSettings(key, patch, version);
  }, [key, patchSettings, version]);
  return [settings, patchForKey];
}

/** 显式重置使旧草稿的异步回调失效；普通卸载/切换不影响版本。 */
export function getComposerDraftVersion(key: string): number {
  return useComposerDraftStore.getState().versions[key] ?? 0;
}

export function useComposerDraftVersion(key: string): number {
  return useComposerDraftStore((state) => state.versions[key] ?? 0);
}

export function useComposerAttachments(key: string): ComposerAttachmentState {
  return useComposerDraftStore((state) => state.drafts[key]?.attachments ?? EMPTY_ATTACHMENTS);
}

export function getComposerAttachments(key: string): ComposerAttachmentState {
  return useComposerDraftStore.getState().drafts[key]?.attachments ?? EMPTY_ATTACHMENTS;
}

export function clearAllComposerDrafts(): void {
  const state = useComposerDraftStore.getState();
  for (const draft of Object.values(state.drafts)) {
    disposeImageResources(draft.attachments.imageResources);
  }
  const keys = new Set([...Object.keys(state.drafts), ...Object.keys(state.versions)]);
  useComposerDraftStore.setState({
    drafts: {},
    versions: Object.fromEntries([...keys].map((key) => [key, (state.versions[key] ?? 0) + 1])),
  });
}

export function composerDraftKey(agentId: string, workerId?: string): string {
  return workerId ? `worker:${agentId}:${workerId}` : `agent:${agentId}`;
}
