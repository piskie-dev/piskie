import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon, Loader2 } from 'lucide-react';
import { resolvePresentationText, type PresentationText } from '../../../i18n/presentationText';
import {
  observeAttachmentThumbnail, openAttachmentImage,
  type AttachmentPreviewOpener, type ThumbnailResult,
} from '../data/composer-drafts';
import type { AttachmentImage } from './model';
import styles from './attachmentThumbnail.module.css';

export function AttachmentError({ error }: { readonly error?: PresentationText }) {
  const { t } = useTranslation();
  return error ? <div role="alert" className={styles.error}>{resolvePresentationText(error, (key, values) => t(key, values))}</div> : null;
}

export function AttachmentThumbnail({ image, alt, className, onPreview }: {
  readonly image: AttachmentImage;
  readonly alt: string;
  readonly className?: string;
  readonly onPreview?: AttachmentPreviewOpener;
}) {
  const { t } = useTranslation();
  const [thumbnail, setThumbnail] = useState<ThumbnailResult>();
  useEffect(() => {
    setThumbnail(undefined);
    if (image.status === 'ready') return observeAttachmentThumbnail(image, setThumbnail);
    return undefined;
  }, [image]);
  const error = image.status === 'error' ? image.error : thumbnail?.kind === 'error' ? thumbnail.error : undefined;
  const errorText = error ? resolvePresentationText(error, (key, values) => t(key, values)) : undefined;
  const label = errorText ?? t(image.status === 'capturing'
    ? 'sessionWorkbenchUi.attachmentFailure.preparing' : 'sessionWorkbenchUi.composer.imageAttachment');
  const open = image.status === 'ready' && onPreview ? () => openAttachmentImage(image, onPreview) : undefined;
  return (
    <span className={styles.item}>
      {thumbnail?.kind === 'ready' && image.status === 'ready' ? (
        <img src={thumbnail.url} alt={image.name || alt} title={image.name || alt} className={className} onClick={open} />
      ) : (
        <button type="button" className={`${styles.placeholder} ${className ?? ''}`} title={image.name ? `${image.name}: ${label}` : label}
          aria-label={label} onClick={open} disabled={!open}>
          {image.status === 'capturing' ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}
        </button>
      )}
      {image.status === 'capturing' && <span role="status" className={styles.caption}>{label}</span>}
      {errorText && <span role="alert" className={styles.error}>{errorText}</span>}
    </span>
  );
}
