/**
 * 画布需要的 worker 投影 —— **一次订阅拿全**。
 *
 * ## 为什么不用现成的 VM
 *
 * - `AgentVM.workers` 是 `WorkerRef`，只有导航信息（subject / status / phase），
 *   **没有能力位**（browserId）——而布局要靠能力位决定出不出屏幕节点。
 * - `useWorkerVM` 有全部字段，但它是**一个 worker 一次订阅**，hooks 不能在循环里调，
 *   而画布上的 worker 数量不定。
 *
 * 所以这里订阅一次显示态，按画布布局需要投影出一个数组。
 *
 * 代价：任一 worker 的任一字段变动都会让本 hook 重算。可接受 ——
 * 节点内部各自窄订阅自己的流水（见 `nodes.tsx`），这里只喂布局用的元数据，
 * 重算成本是一次数组映射。
 */

import { useMemo } from 'react';

import { isInterrupted } from '../../../../../../shared/types/agent-control';
import { useDisplayAgentState } from '../../../../../renderer-runtime/hooks';

export interface CanvasWorker {
  readonly id: string;
  readonly subject: string;
  readonly mode: string;
  /** 小地图按状态着色要用 */
  readonly phase: string;
  readonly interrupted: boolean;
  readonly browserId?: string;
  readonly browserReady: boolean;
}

const EMPTY: readonly CanvasWorker[] = [];

export function useCanvasWorkers(agentId: string | null): readonly CanvasWorker[] {
  const children = useDisplayAgentState(agentId)?.children;

  return useMemo(() => {
    if (!children || children.length === 0) return EMPTY;
    return children.map<CanvasWorker>((child) => ({
      id: child.id,
      subject: child.subject,
      mode: child.mode,
      phase: child.phase,
      interrupted: isInterrupted(child),
      browserId: child.browserId,
      browserReady: !!child.browserReady,
    }));
  }, [children]);
}
