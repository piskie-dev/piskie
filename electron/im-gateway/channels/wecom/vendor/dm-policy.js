import { sendWeComReply } from './message-sender.js';
import { isSenderAllowed } from './group-policy.js';

/**
 * 企业微信 DM（私聊）访问控制模块
 *
 * 负责私聊策略检查、配对流程
 * PISKIE 收编改动：配对能力（pairing: 框架 PairingApi）经参数传入，
 * 替代原 getWeComRuntime().channel.pairing（授权数据源 = IMGateway 授权用户表）
 */
// ============================================================================
// 公开 API
// ============================================================================
/**
 * 检查 DM Policy 访问控制
 * @returns 检查结果，包含是否允许继续处理
 */
async function checkDmPolicy(params) {
    const { senderId, isGroup, account, wsClient, frame, runtime, pairing } = params;
    // 群聊消息不检查 DM Policy
    if (isGroup) {
        return { allowed: true };
    }
    const dmPolicy = account.config.dmPolicy ?? "open";
    const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
    // 如果 dmPolicy 是 disabled，直接拒绝
    if (dmPolicy === "disabled") {
        runtime.log?.(`[WeCom] Blocked DM from ${senderId} (dmPolicy=disabled)`);
        return { allowed: false };
    }
    // 如果是 open 模式，允许所有人
    if (dmPolicy === "open") {
        return { allowed: true };
    }
    // 已授权用户（配对通过 + 手工添加），原为 readAllowFromStore 新旧双签名兼容调用
    const storeAllowFrom = pairing.getAllowedSenders();
    const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const senderAllowedResult = isSenderAllowed(senderId, effectiveAllowFrom);
    if (senderAllowedResult) {
        return { allowed: true };
    }
    // 处理未授权用户
    if (dmPolicy === "pairing") {
        const { code, created } = pairing.request({
            senderId,
            senderName: senderId,
            peerType: "dm",
            peerId: senderId,
        });
        if (created) {
            runtime.log?.(`[WeCom] Pairing request created for sender=${senderId}`);
            try {
                await sendWeComReply({
                    wsClient,
                    frame,
                    text: pairing.buildReply({
                        idLine: `您的企业微信用户ID: ${senderId}`,
                        code,
                    }),
                    runtime,
                    finish: true,
                });
            }
            catch (err) {
                runtime.error?.(`[WeCom] Failed to send pairing reply to ${senderId}: ${String(err)}`);
            }
        }
        else {
            runtime.log?.(`[WeCom] Pairing request already exists for sender=${senderId}`);
        }
        return { allowed: false, pairingSent: created };
    }
    // allowlist 模式：直接拒绝未授权用户
    runtime.log?.(`[WeCom] Blocked unauthorized sender ${senderId} (dmPolicy=${dmPolicy})`);
    return { allowed: false };
}

export { checkDmPolicy };
