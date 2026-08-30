/**
 * 材化上限。
 *
 * `content-visibility: hidden` 只省 CPU（layout/paint），**不省内存**——DOM 节点与
 * React fiber 都还在。所以任何"隐藏但保留"的缓存都必须配驱逐上限，否则长会话里
 * 缓存槽只增不减。这条是 Electron 特有约束里的第一条，也是最容易被"CSS 能省"忽略掉的。
 *
 * 语义：`touch(key)` 把 key 提到最近使用；`keys` 是当前保留集合（最近使用在前），
 * 超出 `limit` 时从最久未使用的一端驱逐。
 *
 * 状态只在事件处理器里写（`touch` 由点击调用），不在 effect 里同步 setState。
 */

import { useCallback, useMemo, useState } from 'react';

export interface LruCache {
  /** 当前保留的 key（最近使用在前） */
  readonly keys: readonly string[];
  readonly has: (key: string) => boolean;
  readonly touch: (key: string) => void;
}

export function useLruCache(limit: number, initial?: string): LruCache {
  const [keys, setKeys] = useState<readonly string[]>(() => (initial ? [initial] : []));

  const touch = useCallback(
    (key: string) => {
      setKeys((current) => {
        if (current[0] === key) return current;
        const next = [key, ...current.filter((candidate) => candidate !== key)];
        return next.length > limit ? next.slice(0, limit) : next;
      });
    },
    [limit],
  );

  const has = useCallback((key: string) => keys.includes(key), [keys]);

  return useMemo(() => ({ keys, has, touch }), [has, keys, touch]);
}
