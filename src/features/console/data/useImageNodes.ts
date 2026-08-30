/**
 * 生图节点的全量态（公开投影）。
 *
 * `AgentVM` / `WorkerVM` 只带 `imageNodeIds`（保持 VM 引用稳定，避免 base64 之外的
 * 大对象参与 memo 比较）。真正要渲染审核区或产物网格时，从这里按 id 取全量态。
 *
 * 主 agent 与 worker 各有自己的 `imageNodes`（worker 也能生图），
 * 因此 `workerId` 有值时取 children 里那一份。
 */

import { useMemo } from 'react';

import type { ImageNodePublicState } from '../../../../shared/types';
import { useDisplayAgentState } from '../../../renderer-runtime/hooks';

const EMPTY: readonly ImageNodePublicState[] = [];

export function useImageNodes(
  agentId: string | null | undefined,
  workerId?: string,
): readonly ImageNodePublicState[] {
  const state = useDisplayAgentState(agentId);
  const nodes = !workerId
    ? state?.imageNodes
    : state?.children.find((child) => child.id === workerId)?.imageNodes;

  return useMemo(() => nodes ?? EMPTY, [nodes]);
}
