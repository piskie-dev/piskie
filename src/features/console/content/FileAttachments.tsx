import { memo } from 'react';
import { FileText } from 'lucide-react';
import type { UserFileRef } from '../../../../shared/types/user-input';
import styles from './FileAttachments.module.css';

/** Local file chips use the desktop's default application; images keep their thumbnail preview. */
export const FileAttachments = memo<{ readonly files: readonly UserFileRef[] }>(({ files }) => (
  <div className={styles.files}>
    {files.map((file, index) => (
      <button
        key={`${file.path}:${index}`}
        type="button"
        className={styles.file}
        title={file.path}
        onClick={() => { void window.piskie.desktop.system.openPath(file.path).catch(() => undefined); }}
      >
        <FileText size={16} aria-hidden />
        <span className={styles.name}>{file.name}</span>
      </button>
    ))}
  </div>
));

FileAttachments.displayName = 'FileAttachments';
