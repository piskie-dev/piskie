export type ImagePreviewHandler = (
  url: string,
  contextUrls?: readonly string[],
  contextIndex?: number,
  /** The preview owner releases the source on close, replacement or unmount. */
  release?: () => void,
  name?: string,
) => void;

export function renderedImageContext(anchor: HTMLImageElement): {
  readonly urls: readonly string[];
  readonly index: number;
} {
  const scope = anchor.closest('[data-image-preview-scope]');
  const images = scope
    ? Array.from(scope.querySelectorAll<HTMLImageElement>('img[src]'))
    : [anchor];
  const entries = images
    .filter((image) => !image.hidden && image.dataset.imagePreview !== 'display-only')
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
