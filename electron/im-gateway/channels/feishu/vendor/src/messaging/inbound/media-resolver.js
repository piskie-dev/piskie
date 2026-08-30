"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Media resolution and payload building for inbound Feishu messages.
 *
 * Downloads media files based on ResourceDescriptors extracted during
 * the content converter phase, and builds the payload object spread
 * into the agent envelope.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadResources = downloadResources;
exports.buildFeishuMediaPayload = buildFeishuMediaPayload;
const lark_client_1 = require("../../core/lark-client.js");
const media_1 = require("../outbound/media.js");
// ---------------------------------------------------------------------------
// Resource-descriptor-based download
// ---------------------------------------------------------------------------
/**
 * Download media files based on pre-extracted ResourceDescriptors from
 * the converter phase.
 */
async function downloadResources(params) {
    const { cfg, messageId, resources, maxBytes, log, accountId } = params;
    if (resources.length === 0)
        return [];
    const out = [];
    const core = lark_client_1.LarkClient.runtime;
    for (const res of resources) {
        try {
            const resourceType = res.type === 'image' ? 'image' : 'file';
            const result = await (0, media_1.downloadMessageResourceFeishu)({
                cfg,
                messageId,
                fileKey: res.fileKey,
                type: resourceType,
                accountId,
            });
            let contentType = result.contentType;
            if (!contentType) {
                contentType = await core.media.detectMime({ buffer: result.buffer });
            }
            const fileName = result.fileName || res.fileName;
            const saved = await core.channel.media.saveMediaBuffer(result.buffer, contentType, 'inbound', maxBytes, fileName);
            const placeholder = inferPlaceholderFromType(res.type);
            out.push({
                path: saved.path,
                contentType: saved.contentType,
                placeholder,
                fileKey: res.fileKey,
                resourceType: res.type,
            });
            log?.(`feishu: downloaded ${res.type} resource ${res.fileKey}, saved to ${saved.path}`);
        }
        catch (err) {
            // PISKIE 本地改动（49号 §4.3.8）：下载失败不得静默丢弃伪装成无附件文本——
            // 以 download-failed:// 哨兵路径显式上报，核心层据此整条明确失败并固定回复
            log?.(`feishu: failed to download ${res.type} resource ${res.fileKey}: ${String(err)}`);
            out.push({
                path: `download-failed://${res.fileKey}`,
                contentType: undefined,
                placeholder: inferPlaceholderFromType(res.type),
                fileKey: res.fileKey,
                resourceType: res.type,
            });
        }
    }
    return out;
}
function inferPlaceholderFromType(type) {
    switch (type) {
        case 'image':
            return '<media:image>';
        case 'file':
            return '<media:document>';
        case 'audio':
            return '<media:audio>';
        case 'video':
            return '<media:video>';
        case 'sticker':
            return '<media:sticker>';
    }
}
// ---------------------------------------------------------------------------
// Media payload builder
// ---------------------------------------------------------------------------
function buildFeishuMediaPayload(mediaList) {
    const first = mediaList[0];
    const mediaPaths = mediaList.map((m) => m.path);
    // PISKIE 本地改动（49号 §4.3.4）：MediaTypes 与 MediaPaths 必须等长、按下标
    // 配对（Host 按下标读 declaredMediaType）——缺失 MIME 以 undefined 占位，
    // 不得 filter(Boolean) 压缩数组造成文件与类型错位；MIME 只是提示，最终
    // 类型由 Pipeline 的文件 magic 检测决定
    const mediaTypes = mediaList.map((m) => m.contentType ?? undefined);
    // PISKIE 本地改动（49号 §4.3.1）：MediaUrl(s) 语义是"需要下载的远程 URL"，
    // 本地已落盘路径只走 MediaPath(s)，不再重复填进 MediaUrl(s)（否则核心层
    // 会把本地路径交给 fetch，飞书图片消息整条失败）
    return {
        MediaPath: first?.path,
        MediaType: first?.contentType,
        MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
        MediaTypes: mediaPaths.length > 0 ? mediaTypes : undefined,
    };
}
