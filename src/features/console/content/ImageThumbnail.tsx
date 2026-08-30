import React, { memo, useEffect, useState } from 'react';

import type { CellMedia } from '../data/cells/media';
import { useImagePreviewUrl } from './useImagePreviewUrl';

interface ImageThumbnailProps {
  readonly resource: CellMedia;
  readonly alt: string;
  readonly className?: string;
  readonly title?: string;
  readonly fallback?: React.ReactNode;
  readonly onPreview?: (
    url: string,
    contextUrls?: readonly string[],
    contextIndex?: number,
  ) => void;
}

function renderedContext(anchor: HTMLImageElement): {
  readonly urls: readonly string[];
  readonly index: number;
} {
  const scope = anchor.closest('[data-image-preview-scope]');
  const images = scope
    ? Array.from(scope.querySelectorAll<HTMLImageElement>('img[src]'))
    : [anchor];
  const entries = images
    .map((image) => ({
      image,
      url: image.currentSrc || image.getAttribute('src') || image.src,
    }))
    .filter((entry) => entry.url.length > 0);
  return {
    urls: entries.map((entry) => entry.url),
    index: entries.findIndex((entry) => entry.image === anchor),
  };
}

/** The only console image element: file resources resolve through the streamed preview protocol. */
export const ImageThumbnail = memo<ImageThumbnailProps>(({
  resource,
  alt,
  className,
  title,
  fallback = null,
  onPreview,
}) => {
  const filePath = resource.kind === 'file' ? resource.path : undefined;
  const fileUrl = useImagePreviewUrl(filePath, 0);
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
        const context = renderedContext(event.currentTarget);
        onPreview(sourceUrl, context.urls, context.index);
      } : undefined}
    />
  );
});

ImageThumbnail.displayName = 'ImageThumbnail';
