import type { ReactNode } from 'react';
import { useAttachmentMenu } from './attachmentMenu';

/** Draft chips retain their existing contents and X button. */
export function AttachmentFileTarget({ file, as: Element = 'div', className, children }: {
  readonly file: { readonly path: string; readonly kind?: 'file' | 'directory' };
  readonly as?: 'div' | 'span';
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const context = useAttachmentMenu({ kind: 'file', path: file.path, directory: file.kind === 'directory' });
  return <>
    <Element className={className} title={file.path} onContextMenu={context.onContextMenu}>{children}</Element>
    {context.menu}
  </>;
}
