import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { copyFile, copyImage, copyText, type ImageCopySource } from '@/services/clipboard';
import { pushToast } from '@/features/toasts';
import type { MenuItemDescriptor } from '../chrome/MenuButton';
import { useContextMenu } from '../chrome/useContextMenu';

export type AttachmentActionKey = 'previewImage' | 'open' | 'copyImage' | 'copyFile' | 'copyPath'
  | 'revealPath' | 'viewChanges' | 'copyContent' | 'copyDiff';

export interface AttachmentMenuAction extends MenuItemDescriptor<AttachmentActionKey> {
  readonly run: () => void | Promise<void>;
  readonly success?: string;
}

export type AttachmentMenuTarget =
  | { readonly kind: 'image'; readonly source: ImageCopySource; readonly preview?: () => void }
  | { readonly kind: 'file'; readonly path: string; readonly directory?: boolean;
      readonly open?: () => void | Promise<void>; readonly reveal?: () => void | Promise<void> };

/** Describes available actions without reading image/file contents. */
export function buildAttachmentActions(target: AttachmentMenuTarget | null, t: TFunction): AttachmentMenuAction[] {
  if (!target) return [];
  const label = (key: string) => t(`contextMenu.attachments.${key}`);
  const actions: AttachmentMenuAction[] = [];
  const path = target.kind === 'file' ? target.path : target.source.kind === 'path' ? target.source.path : undefined;
  const directory = target.kind === 'file' && target.directory;
  if (target.kind === 'image') {
    if (target.preview) actions.push({ key: 'previewImage', label: label('previewImage'), run: target.preview });
    actions.push({ key: 'copyImage', label: label('copyImage'), run: () => copyImage(target.source), success: label('imageCopied') });
  } else {
    actions.push({ key: 'open', label: label(directory ? 'openFolder' : 'openFile'), run: target.open ?? (() => window.piskie.desktop.system.openPath(target.path)) });
  }
  if (path) actions.push(
    { key: 'copyFile', label: label(directory ? 'copyFolder' : 'copyFile'), run: () => copyFile(path), success: label(directory ? 'folderCopied' : 'fileCopied') },
    { key: 'copyPath', label: label('copyPath'), run: () => copyText(path), success: label('pathCopied') },
    { key: 'revealPath', label: label('revealPath'), separatorBefore: true, run: target.kind === 'file' && target.reveal ? target.reveal : () => window.piskie.desktop.system.revealPath(path) },
  );
  return actions;
}

/** Buttons and context menus share completion/error feedback and the same action targets. */
export function useAttachmentMenuActions(actions: readonly AttachmentMenuAction[], ariaLabel?: string) {
  const { t } = useTranslation();
  const perform = async (key: AttachmentActionKey): Promise<void> => {
    const action = actions.find((candidate) => candidate.key === key);
    if (!action) return;
    try {
      await action.run();
      if (action.success) pushToast({ id: 'attachment-action', tone: 'info', title: action.success });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast({ id: 'attachment-action', tone: 'error', title: t('contextMenu.attachments.actionFailed', { message }) });
      throw error;
    }
  };
  const select = (key: AttachmentActionKey) => { void perform(key).catch(() => undefined); };
  const context = useContextMenu({ items: actions, onSelect: select, ariaLabel: ariaLabel ?? t('contextMenu.attachments.menuLabel') });
  return { ...context, perform, select };
}

export function useAttachmentMenu(target: AttachmentMenuTarget | null) {
  const { t } = useTranslation();
  const context = useAttachmentMenuActions(buildAttachmentActions(target, t));
  const source = target?.kind === 'image' ? target.source : undefined;
  const identity = target?.kind === 'file' ? target.path
    : source?.kind === 'path' ? source.path : source?.kind === 'url' ? source.url : source?.blob;
  const { close } = context;
  useEffect(close, [target?.kind, source?.kind, identity, close]);
  return context;
}

