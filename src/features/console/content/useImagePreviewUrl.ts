import { useEffect, useState } from 'react';
import { acquireFilePreview, releaseFilePreview } from './file-preview';

/** Each displayed disk preview owns its token until replacement or unmount. */
export function useImagePreviewUrl(sourcePath: string | undefined, version: number): string | null {
  const [preview, setPreview] = useState<{ sourcePath: string | undefined; version: number; url: string | null }>({
    sourcePath, version, url: null,
  });
  const current = preview.sourcePath === sourcePath && preview.version === version;
  if (!current) setPreview({ sourcePath, version, url: null });
  useEffect(() => {
    if (!sourcePath) return;
    let stale = false;
    let owned: string | undefined;
    const release = releaseFilePreview;
    void acquireFilePreview(sourcePath)
      .then((preview) => {
        if (preview.kind !== 'image') return;
        if (stale) release(preview.url);
        else { owned = preview.url; setPreview({ sourcePath, version, url: preview.url }); }
      })
      .catch(() => { if (!stale) setPreview({ sourcePath, version, url: null }); });
    return () => { stale = true; if (owned) release(owned); };
  }, [sourcePath, version]);
  return sourcePath && current ? preview.url : null;
}
