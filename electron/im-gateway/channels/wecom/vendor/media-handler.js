import { fileTypeFromBuffer } from 'file-type';
import { decryptFile } from '@wecom/aibot-node-sdk';
import { downloadMediaBytes } from '../../../core/media-io.js';
import { MAX_IM_IMAGE_BYTES, MAX_IM_IMAGE_COUNT, MAX_IM_IMAGE_TOTAL_BYTES } from '../../../core/inbound-media.js';

async function downloadAndSave(urls, keys, params) {
    const mediaList = [];
    let totalBytes = 0;
    for (const url of urls) {
        try {
            params.abortSignal?.throwIfAborted();
            if (urls.length > MAX_IM_IMAGE_COUNT) throw new Error('Image count limit exceeded');
            // Both attempts use the media item's own key, including the retry.
            let buffer;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const downloaded = await downloadMediaBytes(url, params.abortSignal, MAX_IM_IMAGE_BYTES + 32);
                    buffer = keys?.get(url) ? decryptFile(downloaded, keys.get(url)) : downloaded;
                    break;
                } catch (error) {
                    if (attempt === 1 || params.abortSignal?.aborted) throw error;
                }
            }
            totalBytes += buffer.length;
            if (buffer.length > MAX_IM_IMAGE_BYTES || totalBytes > MAX_IM_IMAGE_TOTAL_BYTES) {
                throw new Error('Image size limit exceeded');
            }
            const contentType = (await fileTypeFromBuffer(buffer))?.mime;
            params.abortSignal?.throwIfAborted();
            const saved = await params.media.saveBuffer(buffer, contentType, 'inbound', MAX_IM_IMAGE_BYTES);
            mediaList.push({ path: saved.path, contentType: saved.contentType });
        } catch (error) {
            params.runtime.error?.(`[wecom] Media download failed: ${String(error)}`);
            mediaList.push({ path: 'download-failed://media', contentType: undefined });
        }
    }
    return mediaList;
}

export function downloadAndSaveImages(params) {
    return downloadAndSave(params.imageUrls, params.imageAesKeys, params);
}

export function downloadAndSaveFiles(params) {
    return downloadAndSave(params.fileUrls, params.fileAesKeys, params);
}
