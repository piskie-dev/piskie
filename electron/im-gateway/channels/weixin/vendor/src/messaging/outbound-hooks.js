/**
 * PISKIE does not expose OpenClaw's global message hook runtime. Keep the
 * upstream call shape so the vendored transport remains self-contained.
 */
export async function applyWeixinMessageSendingHook(params) {
    return { cancelled: false, text: params.text };
}

export function emitWeixinMessageSent(_params) {
    // Intentionally empty: delivery observability is owned by the PISKIE dispatcher.
}
