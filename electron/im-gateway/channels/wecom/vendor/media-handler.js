import { fileTypeFromBuffer } from 'file-type';
import { fetchRemoteMedia } from './media-compat.js';
import { DEFAULT_MEDIA_MAX_MB, IMAGE_DOWNLOAD_TIMEOUT_MS, FILE_DOWNLOAD_TIMEOUT_MS } from './const.js';
import { withTimeout } from './timeout.js';

/**
 * 企业微信媒体（图片）下载和保存模块
 *
 * 负责下载、检测格式、保存图片到本地，包含超时保护
 */
// ============================================================================
// 图片格式检测辅助函数（基于 file-type 包）
// ============================================================================
/**
 * 检查 Buffer 是否为有效的图片格式
 */
async function isImageBuffer(data) {
    const type = await fileTypeFromBuffer(data);
    return type?.mime.startsWith("image/") ?? false;
}
/**
 * 检测 Buffer 的图片内容类型
 */
async function detectImageContentType(data) {
    const type = await fileTypeFromBuffer(data);
    if (type?.mime.startsWith("image/")) {
        return type.mime;
    }
    return "application/octet-stream";
}
// ============================================================================
// 图片下载和保存
// ============================================================================
/**
 * 下载并保存所有图片到本地，每张图片的下载带超时保护
 */
async function downloadAndSaveImages(params) {
    // PISKIE 收编改动：media（框架 MediaApi）经参数传入，替代原 getWeComRuntime().channel.media；
    // 下载 fallback 改用 media-compat 的 fetchRemoteMedia（buffer 语义，与本文件消费方式一致）
    const { imageUrls, account, runtime, wsClient, media } = params;
    const mediaList = [];
    for (const imageUrl of imageUrls) {
        try {
            runtime.log?.(`[wecom] Downloading image: url=${imageUrl}`);
            // 原读 config.agents.defaults.mediaMaxMb（PISKIE 旧链路从未下发，恒为默认值）
            const mediaMaxMb = account?.config?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
            const maxBytes = mediaMaxMb * 1024 * 1024;
            let imageBuffer;
            let imageContentType;
            let originalFilename;
            const imageAesKey = params.imageAesKeys?.get(imageUrl);
            try {
                // 优先使用 SDK 的 downloadFile 方法下载（带超时保护）
                const result = await withTimeout(wsClient.downloadFile(imageUrl, imageAesKey), IMAGE_DOWNLOAD_TIMEOUT_MS, `Image download timed out: ${imageUrl}`);
                imageBuffer = result.buffer;
                originalFilename = result.filename;
                imageContentType = await detectImageContentType(imageBuffer);
                runtime.log?.(`[wecom] Image downloaded: size=${imageBuffer.length}, contentType=${imageContentType}, filename=${originalFilename ?? '(none)'}`);
            }
            catch (sdkError) {
                // 如果 SDK 方法失败，回退到原有方式（带超时保护）
                runtime.log?.(`[wecom] SDK download failed, fallback: ${String(sdkError)}`);
                const fetched = await withTimeout(fetchRemoteMedia(imageUrl), IMAGE_DOWNLOAD_TIMEOUT_MS, `Manual image download timed out: ${imageUrl}`);
                runtime.log?.(`[wecom] Image fetched: contentType=${fetched.contentType}, size=${fetched.buffer.length}`);
                imageBuffer = fetched.buffer;
                imageContentType = fetched.contentType ?? "application/octet-stream";
                const isValidImage = await isImageBuffer(fetched.buffer);
                if (!isValidImage) {
                    runtime.log?.(`[wecom] WARN: Downloaded data is not a valid image format`);
                }
            }
            const saved = await media.saveBuffer(imageBuffer, imageContentType, "inbound", maxBytes, originalFilename);
            mediaList.push({ path: saved.path, contentType: saved.contentType });
            runtime.log?.(`[wecom][plugin] Image saved: path=${saved.path}, contentType=${saved.contentType}`);
        }
        catch (err) {
            // PISKIE 本地改动（49号 §4.3.8）：下载失败不得静默丢弃伪装成无附件文本——
            // 以 download-failed:// 哨兵条目上报，核心层整条明确失败并固定回复
            runtime.error?.(`[wecom] Failed to download image: ${String(err)}`);
            mediaList.push({ path: `download-failed://${imageUrl}`, contentType: undefined });
        }
    }
    return mediaList;
}
/**
 * 下载并保存所有文件到本地，每个文件的下载带超时保护
 */
async function downloadAndSaveFiles(params) {
    // PISKIE 收编改动：同 downloadAndSaveImages
    const { fileUrls, account, runtime, wsClient, media } = params;
    const mediaList = [];
    for (const fileUrl of fileUrls) {
        try {
            runtime.log?.(`[wecom] Downloading file: url=${fileUrl}`);
            const mediaMaxMb = account?.config?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
            const maxBytes = mediaMaxMb * 1024 * 1024;
            let fileBuffer;
            let fileContentType;
            let originalFilename;
            const fileAesKey = params.fileAesKeys?.get(fileUrl);
            try {
                // 使用 SDK 的 downloadFile 方法下载（带超时保护）
                const result = await withTimeout(wsClient.downloadFile(fileUrl, fileAesKey), FILE_DOWNLOAD_TIMEOUT_MS, `File download timed out: ${fileUrl}`);
                fileBuffer = result.buffer;
                originalFilename = result.filename;
                // 检测文件类型
                const type = await fileTypeFromBuffer(fileBuffer);
                fileContentType = type?.mime ?? "application/octet-stream";
                runtime.log?.(`[wecom] File downloaded: size=${fileBuffer.length}, contentType=${fileContentType}, filename=${originalFilename ?? '(none)'}`);
            }
            catch (sdkError) {
                // 如果 SDK 方法失败，回退到 fetchRemoteMedia（带超时保护）
                runtime.log?.(`[wecom] SDK file download failed, fallback: ${String(sdkError)}`);
                const fetched = await withTimeout(fetchRemoteMedia(fileUrl), FILE_DOWNLOAD_TIMEOUT_MS, `Manual file download timed out: ${fileUrl}`);
                runtime.log?.(`[wecom] File fetched: contentType=${fetched.contentType}, size=${fetched.buffer.length}`);
                fileBuffer = fetched.buffer;
                fileContentType = fetched.contentType ?? "application/octet-stream";
            }
            const saved = await media.saveBuffer(fileBuffer, fileContentType, "inbound", maxBytes, originalFilename);
            mediaList.push({ path: saved.path, contentType: saved.contentType });
            runtime.log?.(`[wecom][plugin] File saved: path=${saved.path}, contentType=${saved.contentType}`);
        }
        catch (err) {
            // PISKIE 本地改动（49号 §4.3.8）：同 downloadAndSaveImages——失败以哨兵条目
            // 上报，核心层整条明确失败，不伪装成无附件文本
            runtime.error?.(`[wecom] Failed to download file: ${String(err)}`);
            mediaList.push({ path: `download-failed://${fileUrl}`, contentType: undefined });
        }
    }
    return mediaList;
}

export { downloadAndSaveFiles, downloadAndSaveImages };
