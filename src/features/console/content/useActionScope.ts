/**
 * useActionScope —— 把面板注册成**键盘焦点作用域**，让 cell 上声明的 `shortcut` 真正可用。
 *
 * ## 补的是哪个缺口
 *
 * `data/keyboard` 早就实现了作用域路由（`registerScope` / `focusScope`），
 * `TranscriptAction.shortcut` 也早就带着 `'mod+b'`（`data/cells/toolCell.ts`），
 * 但**中间这一层一直没人写**：没有任何组件调用 `registerScope`，
 * 于是 `mod+b` 在两个模式里都不响应 —— dock 只能点按钮，thread 连按钮都没有。
 *
 * ## 为什么不是全局绑定
 *
 * 把 `Ctrl+B` 挂全局 keydown、再用 `:hover` 猜"用户说的是哪个面板"的话，多面板并存时
 * 鼠标不在任何面板上就失效、在边界上可能双触发。dock 的画布同屏面板更多，只会更明显。
 *
 * 所以走"焦点作用域"：谁最后被交互过，快捷键就归谁。焦点跟随**捕获阶段**的
 * `pointerdown` 与 `focusin` —— 用捕获是因为面板内部有大量 `stopPropagation`
 * 的控件（菜单、卡片），冒泡阶段收不到。
 *
 * ## 分派规则
 *
 * 从流水**尾部往前**找第一个声明了该 combo 且 `enabled` 的动作。
 * 取尾部是有意的：并行工具调用时用户指的总是最新那条。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { TranscriptNode, TranscriptAction } from '@/domains/transcript/nodes';
import { focusScope, registerScope } from '../data/keyboard';

export interface ActionScopeOptions {
  /** 面板身份；同一时刻只有一个作用域生效，故必须在同屏面板间唯一 */
  readonly scopeId: string;
  readonly nodes: readonly TranscriptNode[];
  /** 命中后执行；与点击同一入口，避免键盘/鼠标两套语义漂移 */
  readonly onAction: (cell: TranscriptNode, action: TranscriptAction) => void;
  /** 说明文案，供将来的快捷键面板列出 */
  readonly description?: string;
  readonly combo?: string;
}

export interface ActionScopeHandlers {
  readonly onPointerDownCapture: () => void;
  readonly onFocusCapture: () => void;
}

/**
 * 从尾部找第一个声明了该 combo 的可用动作。
 * 导出仅为单测（纯函数，无 DOM 依赖）。
 */
export function findShortcutAction(
  nodes: readonly TranscriptNode[],
  combo: string,
): { node: TranscriptNode; action: TranscriptAction } | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node || node.kind !== 'tool') continue;
    const action = node.actions.find((item) => item.shortcut === combo && item.enabled);
    if (action) return { node, action };
  }
  return null;
}

export function useActionScope({
  scopeId,
  nodes,
  onAction,
  description,
  combo = 'mod+b',
}: ActionScopeOptions): ActionScopeHandlers {
  const { t } = useTranslation();
  const resolvedDescription = description ?? t('sessionWorkbenchUi.action.promoteToBackground');
  /**
   * 绑定的 `run` 必须读到**最新**的 cells 与 handler，但又不能因它们变化就重注册
   * （流水每来一条消息都在变，重注册会在高频更新时反复增删 Map 条目）。
   * 所以注册一次、闭包里读 ref。
   *
   * ref 只在 effect 里写 —— 渲染期写 ref 会触发 `react-hooks/refs`，
   * 且在 StrictMode 双渲染下语义不明。
   */
  const latest = useRef({ nodes, onAction });

  useEffect(() => {
    latest.current = { nodes, onAction };
  }, [nodes, onAction]);

  useEffect(() => {
    const dispose = registerScope(scopeId, [
      {
        combo,
        description: resolvedDescription,
        run: () => {
          const hit = findShortcutAction(latest.current.nodes, combo);
          if (hit) latest.current.onAction(hit.node, hit.action);
        },
      },
    ]);
    return dispose;
  }, [combo, resolvedDescription, scopeId]);

  const claim = useCallback(() => focusScope(scopeId), [scopeId]);

  return { onPointerDownCapture: claim, onFocusCapture: claim };
}
