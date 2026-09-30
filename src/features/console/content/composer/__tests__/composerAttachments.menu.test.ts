import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, copyImage } from '@/services/clipboard';
import { resetShortcutRegistry } from '@/shortcuts';
import { useComposerDraftStore, clearAllComposerDrafts, composerDraftKey } from '../../../data/composer-drafts';
import { ConversationComposer } from '../ConversationComposer';
import { WelcomeComposer } from '../WelcomeComposer';
import { installMenuDom, menuLabels, rightClick, selectMenuItem } from '../../../attachments/__tests__/menuTestDom';
import type { AttachmentFile, ReadyAttachmentImage } from '../../../attachments/model';

vi.mock('@/services/clipboard', () => ({ copyImage: vi.fn(), copyFile: vi.fn(), copyText: vi.fn() }));
vi.mock('../../../attachments/thumbnail', () => ({ createImageThumbnail: async (blob: Blob) => blob }));
vi.mock('../ModelPicker', () => ({ ModelPicker: () => null }));
vi.mock('../ContextUsageRing', () => ({ ContextUsageRing: () => null }));
vi.mock('../WorkspaceBar', () => ({ WorkspaceBar: () => null }));
vi.mock('../SessionBrowserControl', () => ({ SessionBrowserControl: () => null }));
vi.mock('../useComposerSettings', () => ({ useComposerSettings: () => ({ modelGroups: [] }) }));
vi.mock('../../../chrome/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const image: ReadyAttachmentImage = { id: 'sample-image', name: 'sample.png', status: 'ready', blob: new Blob(['sample'], { type: 'image/png' }) };
const file: AttachmentFile = { id: 'sample-folder', name: 'sample folder', path: '/workspace/sample folder', kind: 'directory' };
const noop = () => undefined;

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  installMenuDom(dom);
  await i18n.changeLanguage('en-US');
  vi.mocked(copyImage).mockReset().mockResolvedValue(undefined);
  vi.mocked(copyFile).mockReset().mockResolvedValue(undefined);
  Object.assign(window, { piskie: {
    desktop: { system: { platform: 'linux' } },
    capabilities: { market: { availableSkills: async () => [], observeChanges: () => noop } },
    modes: { listAvailable: async () => [] },
  } });
  clearAllComposerDrafts();
  useComposerDraftStore.setState({ drafts: { [composerDraftKey('sample-session')]: {
    text: '', edit: {}, skills: [], browserEnvironmentIds: [], attachments: { images: [image], files: [file] },
  } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  resetShortcutRegistry();
  container.remove();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('composer attachment menus', () => {
  it.each(['welcome', 'conversation'] as const)('exposes the same Blob/folder actions in %s and retains X removal', async (kind) => {
    const remove = vi.fn();
    const preview = vi.fn();
    const view = kind === 'conversation'
      ? createElement(ConversationComposer, { agentId: 'sample-session', targetName: 'Sample task', model: 'sample-model',
        reasoningOverride: { kind: 'provider-default' }, approvalMode: 'confirm', sourceVersion: 0, canPause: true,
        onSubmit: vi.fn().mockResolvedValue(true), onInterrupt: vi.fn().mockResolvedValue(undefined), onPreviewImage: preview })
      : createElement(WelcomeComposer, { value: '', skills: [], draftIdentity: 'sample', onSkillsChange: noop, onChange: noop,
        onSubmit: noop, onPaste: noop, onDragOver: noop, onDrop: noop, placeholder: 'Sample instruction', images: [image], files: [file],
        onRemoveAttachment: remove, onPreviewImage: preview, onModelChange: noop, modeId: 'agent', onModeChange: noop,
        approvalMode: 'confirm', onApprovalModeChange: noop, onSelectWorkspace: noop, onUseDefaultWorkspace: noop,
        environmentIds: [], onEnvironmentIdsChange: noop });
    await act(async () => root.render(view));
    const thumbnail = container.querySelector('img')!;
    expect(thumbnail).not.toBeNull();
    await rightClick(thumbnail);
    expect(menuLabels(container)).toEqual(['Preview image', 'Copy image']);
    expect(preview).not.toHaveBeenCalled();
    await selectMenuItem(container, 'Copy image');
    expect(copyImage).toHaveBeenCalledExactlyOnceWith({ kind: 'blob', blob: image.blob, name: image.name });
    const chip = container.querySelector('[title="/workspace/sample folder"]')!;
    await rightClick(chip);
    expect(menuLabels(container)).toEqual(['Open folder', 'Copy folder', 'Copy path', 'Show in file manager']);
    await selectMenuItem(container, 'Copy folder');
    expect(copyFile).toHaveBeenCalledExactlyOnceWith(file.path);
    await act(async () => chip.querySelector('button')!.click());
    if (kind === 'welcome') expect(remove).toHaveBeenCalledExactlyOnceWith(file.id);
    else expect(useComposerDraftStore.getState().drafts[composerDraftKey('sample-session')]?.attachments.files).toEqual([]);
    await act(async () => thumbnail.click());
    expect(preview).toHaveBeenCalledOnce();
    preview.mock.calls[0]?.[3]?.();
  });
});
