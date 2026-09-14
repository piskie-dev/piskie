import { useEffect, useState } from 'react';
import { acquireFilePreview, releaseFilePreview } from '../services/file-preview';

interface ImagePreviewUrl {
  readonly url: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
}

/** Each displayed disk preview owns its token until replacement or unmount. */
export function useImagePreviewUrl(sourcePath: string | undefined, version = 0): ImagePreviewUrl {
  const initial: ImagePreviewUrl = { url: null, status: sourcePath ? 'loading' : 'idle' };
  const [preview, setPreview] = useState<{
    sourcePath: string | undefined;
    version: number;
    result: ImagePreviewUrl;
  }>({ sourcePath, version, result: initial });
  const current = preview.sourcePath === sourcePath && preview.version === version;
  if (!current) setPreview({ sourcePath, version, result: initial });
  useEffect(() => {
    if (!sourcePath) return;
    let stale = false;
    let owned: string | undefined;
    const release = releaseFilePreview;
    const fail = () => {
      if (!stale) setPreview({ sourcePath, version, result: { url: null, status: 'error' } });
    };
    void acquireFilePreview(sourcePath)
      .then((preview) => {
        if (preview.kind !== 'image') { fail(); return; }
        if (stale) release(preview.url);
        else {
          owned = preview.url;
          setPreview({ sourcePath, version, result: { url: preview.url, status: 'ready' } });
        }
      })
      .catch(fail);
    return () => { stale = true; if (owned) release(owned); };
  }, [sourcePath, version]);
  return current ? preview.result : initial;
}
