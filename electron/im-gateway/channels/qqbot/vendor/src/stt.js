/**
 * 通用 OpenAI 兼容 STT（语音转文字）
 *
 * 为什么在插件侧做 STT 而不走框架管道？
 * 框架的 applyMediaUnderstanding 同时执行 runCapability("audio") 和 extractFileBlocks。
 * 后者会把 WAV 文件的 PCM 二进制当文本注入 Body（looksLikeUtf8Text 误判），导致 context 爆炸。
 * 在插件侧完成 STT 后不把 WAV 放入 MediaPaths，即可规避此框架 bug。
 *
 * 配置解析策略（与 TTS 统一的两级回退）：
 * 1. 优先 channels.qqbot.stt（插件专属配置）
 * 2. 回退 tools.media.audio.models[0]（框架级配置）
 * 3. 再从 models.providers.[provider] 继承 apiKey/baseUrl
 * 4. 支持任何 OpenAI 兼容的 STT 服务
 */
import * as fs from "node:fs";
import path from "node:path";
import { sanitizeFileName } from "./utils/platform.js";
export function resolveSTTConfig(cfg) {
    const c = cfg;
    // 优先使用 channels.qqbot.stt（插件专属配置）
    const channelStt = c?.channels?.qqbot?.stt;
    if (channelStt && channelStt.enabled !== false) {
        const providerId = channelStt?.provider || "openai";
        const providerCfg = c?.models?.providers?.[providerId];
        const baseUrl = channelStt?.baseUrl || providerCfg?.baseUrl;
        const apiKey = channelStt?.apiKey || providerCfg?.apiKey;
        const model = channelStt?.model || "whisper-1";
        if (baseUrl && apiKey) {
            return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
        }
    }
    // 回退到 tools.media.audio.models[0]（框架级配置）
    const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
    if (audioModelEntry) {
        const providerId = audioModelEntry?.provider || "openai";
        const providerCfg = c?.models?.providers?.[providerId];
        const baseUrl = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
        const apiKey = audioModelEntry?.apiKey || providerCfg?.apiKey;
        const model = audioModelEntry?.model || "whisper-1";
        if (baseUrl && apiKey) {
            return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
        }
    }
    return null;
}
export async function transcribeAudio(audioPath, cfg) {
    const sttCfg = resolveSTTConfig(cfg);
    if (!sttCfg)
        return null;
    const fileBuffer = fs.readFileSync(audioPath);
    const fileName = sanitizeFileName(path.basename(audioPath));
    const mime = fileName.endsWith(".wav") ? "audio/wav"
        : fileName.endsWith(".mp3") ? "audio/mpeg"
            : fileName.endsWith(".ogg") ? "audio/ogg"
                : "application/octet-stream";
    const form = new FormData();
    form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
    form.append("model", sttCfg.model);
    const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${sttCfg.apiKey}` },
        body: form,
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
    }
    const result = await resp.json();
    return result.text?.trim() || null;
}
