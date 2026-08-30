/**
 * 粘底 —— 全树**唯一**的滚动 JS。
 *
 * 只有一件事浏览器目前给不了：新内容或底部栏高度变化时
 * "用户仍在底部就跟随，已上翻就别动"。
 * 初始定位不在这里——那是 `scroll-initial-target: nearest` 的活。
 *
 * 全树只此一份，哨兵只有一个布尔——每个滚动容器各写一份的话，每份都会长出自己的
 * "这次是不是程序触发的滚动"补丁。
 */

import { useCallback, useEffect, useRef, useState, type RefObject, type UIEvent } from 'react';

/** 距底部 40px 内仍算"在底部" */
const STICK_THRESHOLD = 40;

export interface StickToBottom {
  readonly onScroll: (event: UIEvent<HTMLElement>) => void;
  /** 强制贴底（发送消息后等场景） */
  readonly scrollToBottom: () => void;
  /**
   * 当前是否在底部附近。**只在跨越阈值时触发重渲染**（不是每次滚动事件），
   * 供"上翻时才出现的回到底部按钮"这类上下文 UI 用。
   */
  readonly atBottom: boolean;
}

/**
 * `deps` 变化即尝试贴底——传"内容长度"或内容数组本身。
 * 加载更早的记录时**不要**让 deps 变化触发贴底，调用方自行 `stick.suspend`：
 * 本 hook 不认识"更早"，只认"用户当前是否在底部"，而向上加载不会改变这一点
 * （加载更早只在顶部插入，用户此刻不在底部，判定自然为 false）。
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
  options?: {
    /**
     * 初始是否贴底(默认 true)。滚动位置驻留恢复"非贴底"位置时传 false,
     * 否则本 hook 的 mount 效应会在恢复之后把容器又打回底部。
     */
    readonly initialStick?: boolean;
  },
): StickToBottom {
  const initialStick = options?.initialStick ?? true;
  const stickRef = useRef(initialStick);
  const [atBottom, setAtBottom] = useState(initialStick);

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const el = event.currentTarget;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    stickRef.current = near;
    // 同值不 setState：滚动过程中不产生重渲染，只在越过阈值那一刻更新
    setAtBottom((previous) => (previous === near ? previous : near));
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    // deps 由调用方给定（内容长度 / 内容数组），本 hook 不解释其内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, ...deps]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollRef, contentRef]);

  return { onScroll, scrollToBottom, atBottom };
}
