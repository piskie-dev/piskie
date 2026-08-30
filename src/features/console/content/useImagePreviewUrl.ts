import { useEffect, useState } from 'react';

/** Resolves a disk image to an opaque streamed URL while retaining the previous frame during refresh. */
export function useImagePreviewUrl(sourcePath: string | undefined, version: number): string | null {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!sourcePath) return;
    let stale = false;
    void window.piskie.desktop.files.preview(sourcePath)
      .then((preview) => {
        if (!stale) setPreviewUrl(preview.kind === 'image' ? preview.url : null);
      })
      .catch(() => {
        if (!stale) setPreviewUrl(null);
      });
    return () => {
      stale = true;
    };
  }, [sourcePath, version]);

  return sourcePath ? previewUrl : null;
}
