import { useEffect, useLayoutEffect, useRef, useState, type MouseEventHandler } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '@/services/clipboard';
import { localPathDirectory } from '@/utils/localPath';
import { useAttachmentMenuActions, type AttachmentMenuAction } from './attachmentMenu';

export type PathAction = (path: string) => void | Promise<void>;

export function useReviewMenu({ path, text, copyKind = 'copyContent', viewChanges, onRevealPath, onOpenPath, missing = false }: {
  readonly path: string;
  readonly text?: string | null;
  readonly copyKind?: 'copyContent' | 'copyDiff';
  readonly viewChanges?: () => void;
  readonly onRevealPath?: PathAction;
  readonly onOpenPath?: PathAction;
  readonly missing?: boolean;
}) {
  const { t } = useTranslation();
  const [location, setLocation] = useState<{ path: string; missing: boolean } | null>(null);
  const owner = useRef({ path, sequence: 0 });
  useLayoutEffect(() => {
    const current = owner.current;
    current.path = path;
    current.sequence += 1;
    return () => { current.sequence += 1; };
  }, [path]);
  const parent = localPathDirectory(path);
  const isMissing = missing || (location?.path === path && location.missing);
  const reveal = async () => {
    const revision = await window.piskie.desktop.files.revision(path);
    if (revision === null && parent) {
      await (onOpenPath ?? window.piskie.desktop.system.openPath)(parent);
    } else {
      await (onRevealPath ?? window.piskie.desktop.system.revealPath)(path);
    }
  };
  const label = (key: string) => t(`contextMenu.attachments.${key}`);
  const actions: AttachmentMenuAction[] = [];
  if (viewChanges) actions.push({ key: 'viewChanges', label: label('viewChanges'), run: viewChanges });
  if (text !== null && text !== undefined) actions.push({
    key: copyKind, label: label(copyKind), run: () => copyText(text), success: label(copyKind === 'copyDiff' ? 'diffCopied' : 'contentCopied'),
  });
  actions.push(
    { key: 'copyPath', label: label('copyPath'), run: () => copyText(path), success: label('pathCopied') },
    { key: 'revealPath', label: label(isMissing && parent ? 'openParentFolder' : 'revealPath'), separatorBefore: true, run: reveal },
  );
  const context = useAttachmentMenuActions(actions, t('contextMenu.attachments.reviewMenuLabel'));
  const { close } = context;
  useEffect(close, [path, copyKind, close]);
  const onContextMenu: MouseEventHandler<HTMLElement> = (event) => {
    const alreadyHandled = event.defaultPrevented;
    context.onContextMenu(event);
    if (alreadyHandled || !event.defaultPrevented) return;
    const sequence = ++owner.current.sequence;
    // The review contract records historical calls, so presence comes from current metadata only.
    void window.piskie.desktop.files.revision(path).then((revision) => {
      if (owner.current.path === path && owner.current.sequence === sequence) setLocation({ path, missing: revision === null });
    }).catch(() => undefined);
  };
  return { ...context, onContextMenu,
    revealLabel: isMissing && parent ? label('openParentFolder') : t('sessionWorkbenchUi.review.showInFolder'),
  };
}
