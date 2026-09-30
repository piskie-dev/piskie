import { memo } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import type { UserFileRef } from '../../../../shared/types/user-input';
import { useAttachmentMenu } from '../attachments/attachmentMenu';
import styles from './FileAttachments.module.css';

const FileAttachment = memo<{ readonly file: UserFileRef }>(({ file }) => {
  const context = useAttachmentMenu({ kind: 'file', path: file.path, directory: file.kind === 'directory' });
  return <>
    <button
      type="button"
      className={styles.file}
      title={file.path}
      onClick={() => context.select('open')}
      onContextMenu={context.onContextMenu}
    >
      {file.kind === 'directory' ? <FolderOpen size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
      <span className={styles.name}>{file.name}</span>
    </button>
    {context.menu}
  </>;
});
FileAttachment.displayName = 'FileAttachment';

/** Local file chips use the desktop's default application; images keep their thumbnail preview. */
export const FileAttachments = memo<{ readonly files: readonly UserFileRef[] }>(({ files }) => (
  <div className={styles.files}>
    {files.map((file, index) => (
      <FileAttachment key={`${file.path}:${index}`} file={file} />
    ))}
  </div>
));

FileAttachments.displayName = 'FileAttachments';
