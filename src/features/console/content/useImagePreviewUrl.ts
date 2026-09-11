import { useEffect, useState } from 'react';
import { acquireFilePreview, releaseFilePreview } from './file-preview';

/** Each displayed disk preview owns its token until replacement or unmount. */
export function useImagePreviewUrl(sourcePath: string | undefined, version: number): string | null {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    setPreviewUrl(null);
    if (!sourcePath) return;
    let stale = false;
    let owned: string | undefined;
    const release = releaseFilePreview;
    void acquireFilePreview(sourcePath)
      .then((preview) => {
        if (preview.kind !== 'image') return;
        if (stale) release(preview.url);
        else { owned = preview.url; setPreviewUrl(preview.url); }
      })
      .catch(() => { if (!stale) setPreviewUrl(null); });
    return () => { stale = true; if (owned) release(owned); };
  }, [sourcePath, version]);
  return sourcePath ? previewUrl : null;
}
