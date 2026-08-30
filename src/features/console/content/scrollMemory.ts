/**
 * 流水滚动位置驻留(2026-08-25):Transcript 按目标重挂后,各目标离开时
 * 记住"具体位置或正在贴底",切回原样恢复——主/子各记各的,互不残留。
 * 纯内存临时驻留(与输入草稿同口径):不落盘、无新字段、应用刷新即清。
 */

export interface ScrollMemoryEntry {
  readonly top: number;
  /** 离开时贴在底部:恢复时不还原像素位置,继续跟随最新 */
  readonly atBottom: boolean;
}

const entries: Record<string, ScrollMemoryEntry> = {};

export function saveScrollMemory(key: string, entry: ScrollMemoryEntry): void {
  entries[key] = entry;
}

export function readScrollMemory(key: string): ScrollMemoryEntry | undefined {
  return entries[key];
}
