/**
 * 键盘注册的 React 绑定（`data/keyboard` 的纯注册表 + 这里的挂载语义）。
 *
 * 分文件的理由与 `sessionRow.ts` / `gates/resolve.ts` 一致：`keyboard.ts` 是纯逻辑
 * （可在 node 环境直接单测），hook 放这里，两边互不牵连。
 *
 * `enabled` 为 false 时**不注册**，而不是注册一个空函数——这样才能让优先级链
 * 自然往下走（例如 dock 没有选中 worker 时，Esc 就该什么都不做，而不是被一个
 * 空 handler 吃掉）。
 */

import { useEffect } from 'react';

import { registerGlobalBinding } from './keyboard';

export function useGlobalBinding(
  combo: string,
  description: string,
  run: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    return registerGlobalBinding({ combo, description, run });
  }, [combo, description, enabled, run]);
}
