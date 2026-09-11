import { useCallback, useRef } from 'react';
import { useAgentRunList, useRendererRuntime } from '@/renderer-runtime/hooks';

export function useMessageReadReceipt(agentId: string | undefined) {
  const { agentRuns } = useRendererRuntime();
  const messages = useAgentRunList((state) => agentId
    ? state.runs.find((run) => run.agentId === agentId)?.messages : undefined);
  const pending = useRef(new Set<string>());
  const onLatestMessageVisible = useCallback((index: number) => {
    if (!agentId || !messages || index <= messages.readThroughIndex) return;
    const key = `${agentId}:${index}`;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    void agentRuns.markRead(agentId, index)
      .catch((error) => console.error('Failed to save conversation read position:', error))
      .finally(() => pending.current.delete(key));
  }, [agentId, agentRuns, messages]);
  return {
    latestMessageIndex: messages?.latestMessage?.index,
    onLatestMessageVisible,
  };
}
