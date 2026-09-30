import { BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { PublicOperationError } from '../../capabilities/public-errors.js';

const DECODER_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; connect-src data:">',
)}`;

/** PNG uses Electron's native decoder; Chromium also applies JPEG EXIF orientation. */
export async function decodeClipboardImage(bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<NativeImage> {
  signal?.throwIfAborted();
  if (mediaType === 'image/png') {
    return nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  const decoder = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  const dataUrl = `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      await decoder.loadURL(DECODER_PAGE);
      signal?.throwIfAborted();
      // SVG is only an image resource, never an executable document. The page cannot access the network.
      const png: string = await decoder.webContents.executeJavaScript(`(async () => {
        const url = ${JSON.stringify(dataUrl)};
        const svg = ${JSON.stringify(mediaType === 'image/svg+xml')};
        let image;
        if (svg) {
          image = new Image();
          image.src = url;
          await image.decode();
        } else {
          image = await createImageBitmap(await (await fetch(url)).blob());
        }
        try {
          const width = svg ? image.naturalWidth : image.width;
          const height = svg ? image.naturalHeight : image.height;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(image, 0, 0);
          return canvas.toDataURL('image/png');
        } finally {
          if (!svg) image.close();
        }
      })()`);
      signal?.throwIfAborted();
      return nativeImage.createFromDataURL(png);
    })()]);
  } catch (error) {
    signal?.throwIfAborted();
    throw new PublicOperationError('invalid-input', error instanceof Error ? error.message : 'The source image could not be decoded');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!decoder.isDestroyed()) decoder.destroy();
  }
}
