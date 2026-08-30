/**
 * useRemoteInput —— 把预览面板里的鼠标/键盘转发进被控浏览器。
 *
 * 设计要点：
 * - **指针捕获**：按下即 `setPointerCapture`，拖拽出面板边界仍能收到 move/up。
 *   否则在页面里拖滚动条、拖选文字一出界就断，表现为"卡住不放手"。
 * - **键盘要焦点**：宿主是 `tabIndex=0` 的 div，点击自动获得焦点后才收键盘事件。
 *   转发期间要 `preventDefault`，否则空格/方向键会同时滚动我们自己的面板。
 * - **滚轮**：`passive: false` 的原生监听（React 的 onWheel 是 passive，
 *   preventDefault 无效，会连带滚动外层容器）。
 * - 帧尺寸未知（首帧未到）时不转发：没有坐标基准，发过去就是错位点击。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RemoteInputEvent } from '../../../../../shared/types/stream';
import { buttonNameOf, modifiersOf, toKeyEvent, toPageCoords, type FrameSize } from './remoteInput';

interface RemoteInputOptions {
  readonly enabled: boolean;
  readonly frameSize: FrameSize | null;
  readonly send: (event: RemoteInputEvent) => void;
}

interface RemoteInputHandlers {
  readonly ref: (node: HTMLElement | null) => void;
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  readonly onKeyUp: (event: React.KeyboardEvent<HTMLElement>) => void;
  readonly onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
}

export function useRemoteInput(options: RemoteInputOptions): RemoteInputHandlers {
  const { enabled, frameSize, send } = options;

  const hostRef = useRef<HTMLElement | null>(null);
  // 事件回调里要读最新值，但不该因为它变化而重绑监听
  const latest = useRef({ enabled, frameSize, send });
  useEffect(() => {
    latest.current = { enabled, frameSize, send };
  }, [enabled, frameSize, send]);

  const coordsOf = useCallback((clientX: number, clientY: number) => {
    const { frameSize: frame } = latest.current;
    const host = hostRef.current;
    if (!host || !frame) return null;
    return toPageCoords(host, clientX, clientY, frame);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!latest.current.enabled) return;
      const point = coordsOf(event.clientX, event.clientY);
      if (!point) return;
      // 焦点给宿主，键盘才有去处；捕获指针，拖出边界不断流
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      latest.current.send({
        kind: 'mouse',
        type: 'mousePressed',
        ...point,
        button: buttonNameOf(event.button),
        buttons: event.buttons,
        clickCount: event.detail || 1,
        modifiers: modifiersOf(event),
      });
    },
    [coordsOf],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!latest.current.enabled) return;
      const point = coordsOf(event.clientX, event.clientY);
      if (!point) return;
      latest.current.send({
        kind: 'mouse',
        type: 'mouseMoved',
        ...point,
        // 移动时 button 恒 none、buttons 表达当前按住的键（CDP 的拖拽语义）
        button: event.buttons === 0 ? 'none' : buttonNameOf(event.button),
        buttons: event.buttons,
        modifiers: modifiersOf(event),
      });
    },
    [coordsOf],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!latest.current.enabled) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const point = coordsOf(event.clientX, event.clientY);
      if (!point) return;
      latest.current.send({
        kind: 'mouse',
        type: 'mouseReleased',
        ...point,
        button: buttonNameOf(event.button),
        buttons: event.buttons,
        clickCount: event.detail || 1,
        modifiers: modifiersOf(event),
      });
    },
    [coordsOf],
  );

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!latest.current.enabled) return;
    // 全局快捷键（切模式/搜索等）留给应用，不劫持
    if (event.metaKey || event.ctrlKey) {
      if (event.key !== 'a' && event.key !== 'c' && event.key !== 'v' && event.key !== 'x') return;
    }
    const keyEvent = toKeyEvent(event.nativeEvent, 'down');
    if (!keyEvent) return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.send(keyEvent);
  }, []);

  const onKeyUp = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!latest.current.enabled) return;
    if (event.metaKey || event.ctrlKey) return;
    const keyEvent = toKeyEvent(event.nativeEvent, 'up');
    if (!keyEvent) return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.send(keyEvent);
  }, []);

  const onContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    // 右键已作为 mousePressed 转发进页面，本地菜单不该再弹
    if (latest.current.enabled) event.preventDefault();
  }, []);

  // ref 回调只登记节点：React 18 的 ref 回调不支持返回清理函数（那是 19 的能力），
  // 监听放 effect 里才有对称的解绑
  const [host, setHost] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    hostRef.current = node;
    setHost(node);
  }, []);

  /**
   * 滚轮：React 的 onWheel 是 passive，preventDefault 无效，必须原生绑定。
   *
   * **纵向转发给被控页面，横向留给本地容器**：画面按 cover 铺满后
   * 通常横向溢出，要靠容器横滚才够得到右半边；而纵向滚动的语义显然属于网页本身。
   * 横向事件不 preventDefault 即冒泡到 `.viewport` 触发原生滚动。
   */
  useEffect(() => {
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (!latest.current.enabled) return;
      // 横向为主的滚动 ⇒ 本地平移画面，不进被控页
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const point = coordsOf(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      latest.current.send({
        kind: 'mouse',
        type: 'mouseWheel',
        ...point,
        // DOM 的 deltaY 向下为正，CDP 的 deltaY 向下为负，符号相反；
        // 横向分量不转发（已在上面放行给本地容器平移，这里清零避免双重滚动）
        deltaX: 0,
        deltaY: -event.deltaY,
        modifiers: modifiersOf(event),
      });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [host, coordsOf]);

  return { ref, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onKeyUp, onContextMenu };
}
