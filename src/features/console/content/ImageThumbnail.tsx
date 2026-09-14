import React, { memo, useEffect, useState } from 'react';

import type { CellMedia } from '../data/cells/media';
import { useImagePreviewUrl } from '@/hooks/useImagePreviewUrl';
import { renderedImageContext, type ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';

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

  useEffect(() => setFailed(false), [sourceKey]);

  if (!sourceUrl || failed) return <>{fallback}</>;
  return (
    <img
      src={sourceUrl}
      alt={alt}
      title={title}
      className={className}
      onError={() => setFailed(true)}
      onClick={onPreview ? (event) => {
        const context = renderedImageContext(event.currentTarget);
        onPreview(sourceUrl, context.urls, context.index);
      } : undefined}
    />
  );
});

ImageThumbnail.displayName = 'ImageThumbnail';
