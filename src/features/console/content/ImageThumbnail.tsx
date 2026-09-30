import React, { memo, useEffect, useRef, useState } from 'react';

import type { CellMedia } from '../data/cells/media';
import { useImagePreviewUrl } from '@/hooks/useImagePreviewUrl';
import { renderedImageContext, type ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';
import { useAttachmentMenu } from '../attachments/attachmentMenu';

interface ImageThumbnailProps {
  readonly resource: CellMedia;
  readonly alt: string;
  readonly className?: string;
  readonly title?: string;
  readonly fallback?: React.ReactNode;
  readonly onPreview?: ImagePreviewHandler;
}

/** Attachment file resources resolve through the shared preview protocol. */
export const ImageThumbnail = memo<ImageThumbnailProps>(({
  resource,
  alt,
  className,
  title,
  fallback = null,
  onPreview,
}) => {
  const filePath = resource.kind === 'file' ? resource.path : undefined;
  const { url: fileUrl } = useImagePreviewUrl(filePath);
  const sourceUrl = resource.kind === 'preview-url' ? resource.url : fileUrl;
  const sourceKey = resource.kind === 'file' ? `file:${resource.path}` : `url:${resource.url}`;
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const preview = onPreview && sourceUrl && !failed ? () => {
    const image = imageRef.current;
    if (!image) return;
    const context = renderedImageContext(image);
    onPreview(sourceUrl, context.urls, context.index, undefined, undefined, context.sourcePaths);
  } : undefined;
  const context = useAttachmentMenu({ kind: 'image',
    source: resource.kind === 'file' ? { kind: 'path', path: resource.path } : { kind: 'url', url: resource.url },
    preview,
  });

  useEffect(() => setFailed(false), [sourceKey]);

  if (!sourceUrl || failed) return <><span onContextMenu={context.onContextMenu}>{fallback}</span>{context.menu}</>;
  return (
    <><img
      ref={imageRef}
      src={sourceUrl}
      data-image-source-path={filePath}
      alt={alt}
      title={title}
      className={className}
      onError={() => setFailed(true)}
      onClick={preview}
      onContextMenu={context.onContextMenu}
    />{context.menu}</>
  );
});

ImageThumbnail.displayName = 'ImageThumbnail';
