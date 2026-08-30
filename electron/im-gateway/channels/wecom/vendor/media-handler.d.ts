/**
 * 企业微信媒体（图片）下载和保存模块
 *
 * 负责下载、检测格式、保存图片到本地，包含超时保护
 */
import type { RuntimeEnv } from "./compat-types.js";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { ResolvedWeComAccount } from "./compat-types.js";
import type { MediaApi } from "../../core/channel-connector.js";
/**
 * 下载并保存所有图片到本地，每张图片的下载带超时保护
 */
export declare function downloadAndSaveImages(params: {
    imageUrls: string[];
    imageAesKeys?: Map<string, string>;
    account: ResolvedWeComAccount;
    media: MediaApi;
    runtime: RuntimeEnv;
    wsClient: WSClient;
}): Promise<Array<{
    path: string;
    contentType?: string;
}>>;
/**
 * 下载并保存所有文件到本地，每个文件的下载带超时保护
 */
export declare function downloadAndSaveFiles(params: {
    fileUrls: string[];
    fileAesKeys?: Map<string, string>;
    account: ResolvedWeComAccount;
    media: MediaApi;
    runtime: RuntimeEnv;
    wsClient: WSClient;
}): Promise<Array<{
    path: string;
    contentType?: string;
}>>;
