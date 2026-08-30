import { setOpenClawVersion } from "./api.js";
let runtime = null;
export function setQQBotRuntime(next) {
    runtime = next;
    // 将框架版本注入 User-Agent（runtime 注入后才能拿到准确版本）
    setOpenClawVersion(next.version);
}
export function getQQBotRuntime() {
    if (!runtime) {
        throw new Error("QQBot runtime not initialized");
    }
    return runtime;
}
