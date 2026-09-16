import { useEffect, useRef } from 'react';
import { useAgentRunList, useRendererRuntime } from '@/renderer-runtime/hooks';

/**
 * 打开即已读:主会话在前台展示期间,最新消息位置直接记为已读位置。
 * 不看滚动或可见性——用户读到哪里由用户决定,界面推断不可靠
 * (读一半觉得够了接着聊,也不该被判成未读)。
 */
export function useMarkSessionRead(agentId: string | undefined): void {
  const { agentRuns } = useRendererRuntime();
  const messages = useAgentRunList((state) => agentId
    ? state.runs.find((run) => run.agentId === agentId)?.messages : undefined);
  const unreadActionIds = useAgentRunList((state) => agentId
    ? state.attentionByAgentId[agentId]?.unreadActionIds : undefined);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    if (!agentId) return;
    const index = messages?.latestMessage?.index ?? -1;
    if (index <= (messages?.readThroughIndex ?? -1) && !unreadActionIds?.length) return;
    const key = JSON.stringify([agentId, index, unreadActionIds]);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    void agentRuns.markRead(agentId, index)
      .catch((error) => console.error('Failed to save conversation read position:', error))
      .finally(() => pending.current.delete(key));
  }, [agentId, agentRuns, messages, unreadActionIds]);
}
