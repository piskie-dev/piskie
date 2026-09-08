import { useEffect, useState } from 'react';
import type { AgentTarget } from '../../../../../shared/types/agent-control';
import { EMPTY_EMBEDDED_BROWSER_STATE, type EmbeddedBrowserState } from '../../../../../shared/types/embedded-browser';

export function useEmbeddedBrowserState(target: AgentTarget | undefined): EmbeddedBrowserState {
  const [snapshot, setSnapshot] = useState<{ target: AgentTarget; state: EmbeddedBrowserState }>();
  const agentId = target?.agentId;
  const workerId = target?.workerId;

  useEffect(() => {
    if (!agentId) return;
    const owner = { agentId, workerId };
    let active = true;
    const unsubscribe = window.piskie.pilot.embeddedBrowser.observeState(owner, (state) => {
      if (active) setSnapshot({ target: owner, state });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [agentId, workerId]);

  return snapshot && snapshot.target.agentId === agentId && snapshot.target.workerId === workerId
    ? snapshot.state
    : EMPTY_EMBEDDED_BROWSER_STATE;
}
