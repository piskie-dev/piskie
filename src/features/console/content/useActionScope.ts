/**
 * useActionScope —— 把面板注册成**键盘焦点作用域**，让 cell 的后台化动作可用快捷键触发。
 *
 * ## 补的是哪个缺口
 *
 * Transcript action 只声明业务动作，实际键位由共享 catalog 与用户设置派生。
 * 面板把该命令注册到应用级路由，保证改键与禁用即时生效。
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
 * 从流水**尾部往前**找第一个可用的后台化动作。
 * 取尾部是有意的：并行工具调用时用户指的总是最新那条。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { TranscriptNode, TranscriptAction } from '@/domains/transcript/nodes';
import {
  activateFocusedShortcutScope,
  registerShortcutBinding,
  useShortcutScope,
  type ShortcutScope,
} from '@/shortcuts';
import { useEffectiveConsoleShortcut } from '../data/shortcuts';

export interface ActionScopeOptions {
  /** 面板身份；同一时刻只有一个作用域生效，故必须在同屏面板间唯一 */
  readonly scopeId: string;
  readonly nodes: readonly TranscriptNode[];
  /** 命中后执行；与点击同一入口，避免键盘/鼠标两套语义漂移 */
  readonly onAction: (cell: TranscriptNode, action: TranscriptAction) => void;
  /** Dock 用同一次面板交互更新 active primary owner。 */
  readonly onActivateOwner?: () => void;
}

export interface ActionScopeHandlers {
  readonly onPointerDownCapture: () => void;
  readonly onFocusCapture: () => void;
}

/**
 * 从尾部找第一个可用的后台化动作。
 * 导出仅为单测（纯函数，无 DOM 依赖）。
 */
export function findShortcutAction(
  nodes: readonly TranscriptNode[],
): { node: TranscriptNode; action: TranscriptAction } | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node || node.kind !== 'tool') continue;
    const action = node.actions.find((item) => (
      item.kind === 'promote-to-background' && item.enabled
    ));
    if (action) return { node, action };
  }
  return null;
}

export function useActionScope({
  scopeId,
  nodes,
  onAction,
  onActivateOwner,
}: ActionScopeOptions): ActionScopeHandlers {
  const shortcut = useEffectiveConsoleShortcut('tool.promoteToBackground');
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

  const routerScopeId = `console-action:${scopeId}`;
  const scope = useMemo<ShortcutScope>(() => ({
    id: routerScopeId,
    layer: 'focused-control-fallback',
    blocksLowerLayers: 'none',
    bindings: [],
  }), [routerScopeId]);
  useShortcutScope(scope);
  useEffect(() => {
    if (!shortcut) return;
    return registerShortcutBinding(routerScopeId, {
      id: `${routerScopeId}:promote-to-background`,
      commandId: 'tool.promoteToBackground',
      combo: shortcut.physicalCombo,
      enabled: () => findShortcutAction(latest.current.nodes) !== null,
      allowInEditable: true,
      handling: 'execute',
      defaultBehavior: 'prevent',
      execute: () => {
        const hit = findShortcutAction(latest.current.nodes);
        if (hit) latest.current.onAction(hit.node, hit.action);
      },
    });
  }, [routerScopeId, shortcut]);

  const claim = useCallback(() => {
    activateFocusedShortcutScope(routerScopeId);
    onActivateOwner?.();
  }, [onActivateOwner, routerScopeId]);

  return { onPointerDownCapture: claim, onFocusCapture: claim };
}
