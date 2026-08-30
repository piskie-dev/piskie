import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentMcpView } from '../../../../shared/types/mcp';
import {
  hasMcpPrewarmApi,
  prewarmMcp,
  readMcpPrewarm,
  releaseMcpPrewarm,
  type McpPrewarmRequest,
} from './mcpRuntime';

interface McpPrewarmState {
  requestKey: string;
  token?: string;
  view?: AgentMcpView;
  error?: string;
  claimed?: boolean;
}

export interface McpPrewarmController extends McpPrewarmState {
  /** Reserve the current lease for the next `mainAgent.start` invocation. */
  claim: () => string | undefined;
  /** A successful start consumes the lease; a failed start releases and recreates it. */
  settle: (token: string | undefined, adopted: boolean) => void;
}

const POLL_MS = 750;
const STABILIZE_MS = 180;

/** MCP selection is a set; object/array identity and selection order are not lifecycle inputs. */
export function mcpPrewarmRequestKey(request: McpPrewarmRequest | null): string {
  if (!request) return '';
  const selection = request.runSelection === undefined
    ? null
    : [...new Set(request.runSelection)].sort();
  return JSON.stringify([request.specName, request.workspace ?? null, selection]);
}

function requestFromKey(requestKey: string): McpPrewarmRequest | null {
  if (!requestKey) return null;
  const [specName, workspace, runSelection] = JSON.parse(requestKey) as [
    string,
    string | null,
    string[] | null,
  ];
  return {
    specName,
    workspace: workspace ?? undefined,
    runSelection: runSelection ?? undefined,
  };
}

export function useMcpPrewarm(
  request: McpPrewarmRequest | null,
): McpPrewarmController {
  const [state, setState] = useState<McpPrewarmState>({ requestKey: '' });
  const [attempt, setAttempt] = useState(0);
  const claimed = useRef(new Set<string>());
  const requestKey = mcpPrewarmRequestKey(request);
  const stableRequest = useMemo(() => requestFromKey(requestKey), [requestKey]);

  useEffect(() => {
    if (!stableRequest || !hasMcpPrewarmApi()) return undefined;

    let cancelled = false;
    let leaseToken: string | undefined;
    const claimedTokens = claimed.current;
    const timer = window.setTimeout(() => {
      void prewarmMcp(stableRequest)
        .then((lease) => {
          if (!lease) return;
          leaseToken = lease.token;
          if (cancelled) {
            void releaseMcpPrewarm(lease.token);
            return;
          }
          setState({ requestKey, token: lease.token, view: lease.view });
        })
        .catch((error) => {
          if (!cancelled) setState({
            requestKey,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, STABILIZE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (leaseToken && !claimedTokens.has(leaseToken)) void releaseMcpPrewarm(leaseToken);
    };
  }, [attempt, requestKey, stableRequest]);

  useEffect(() => {
    if (state.requestKey !== requestKey || !state.token || state.claimed) return undefined;
    let cancelled = false;
    let expired = false;
    const poll = () => {
      void readMcpPrewarm(state.token!)
        .then((view) => {
          if (cancelled || expired) return;
          // `claim()` marks the ref synchronously; an already in-flight status read may
          // resolve after Main adopted the token and legitimately return null.
          if (claimed.current.has(state.token!)) return;
          if (!view) {
            expired = true;
            setState({ requestKey });
            setAttempt((value) => value + 1);
            return;
          }
          setState((current) => (
            current.requestKey === requestKey && current.token === state.token
              ? { ...current, view, error: undefined }
              : current
          ));
        })
        .catch((error) => {
          if (!cancelled && !claimed.current.has(state.token!)) setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    };
    const interval = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [requestKey, state.claimed, state.requestKey, state.token]);

  const claim = useCallback(() => {
    const token = state.token;
    if (token) {
      claimed.current.add(token);
      setState((current) => (
        current.token === token ? { ...current, claimed: true } : current
      ));
    }
    return token;
  }, [state.token]);

  const settle = useCallback((token: string | undefined, adopted: boolean) => {
    if (!token) return;
    if (adopted) {
      // The Main runtime now owns this connection. Unmount cleanup must not release it.
      setState((current) => (
        current.token === token ? { requestKey: current.requestKey } : current
      ));
      return;
    }
    claimed.current.delete(token);
    void releaseMcpPrewarm(token).finally(() => {
      setState({ requestKey: '' });
      setAttempt((value) => value + 1);
    });
  }, []);

  const visible = state.requestKey === requestKey ? state : { requestKey };
  return { ...visible, claim, settle };
}
