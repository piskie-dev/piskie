import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceGitHead, WorkspaceInfo } from '../../../../../shared/electron-contracts/desktop';
import { messageText, presentationFromError, type PresentationText } from '../../../../i18n/presentationText';

interface WorkspaceResult {
  readonly revision: number;
  readonly info?: WorkspaceInfo;
  readonly error?: PresentationText;
}

function readResult(info: WorkspaceInfo, revision: number): WorkspaceResult {
  return { revision, info, error: info.error
    ? messageText('sessionWorkbenchUi.composer.workspaceReadFailed', { error: info.error }) : undefined };
}

/** null means an older Worker did not record its workspace; undefined selects the default. */
export function useWorkspaceInfo(workspace: string | null | undefined) {
  const [result, setResult] = useState<WorkspaceResult>();
  const [revision, setRevision] = useState(0);
  const [switchError, setSwitchError] = useState<PresentationText>();
  const [createError, setCreateError] = useState<PresentationText>();
  const [pending, setPending] = useState<'switch' | 'create'>();
  const requestOwner = useRef({ sequence: 0 });
  const pendingRef = useRef(false);
  const info = result?.info;

  const refresh = useCallback(() => {
    if (workspace !== null && !pendingRef.current) setRevision((value) => value + 1);
  }, [workspace]);

  useEffect(() => {
    if (workspace === null) return;
    const owner = requestOwner.current;
    const request = ++owner.sequence;
    void (async () => {
      try {
        const next = await window.piskie.desktop.workspace.info(workspace);
        if (request === requestOwner.current.sequence) setResult(readResult(next, revision));
      } catch (cause) {
        if (request === requestOwner.current.sequence) setResult({ revision, error: messageText('sessionWorkbenchUi.composer.workspaceReadFailed', {
          error: presentationFromError(cause, messageText('sessionWorkbenchUi.composer.workspaceUnavailable')),
        }) });
      }
    })();
    return () => { owner.sequence++; };
  }, [workspace, revision]);

  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const changeBranch = useCallback(async (branch: string, base?: WorkspaceGitHead): Promise<boolean> => {
    if (!info || pendingRef.current) return false;
    pendingRef.current = true;
    const request = ++requestOwner.current.sequence;
    setPending(base ? 'create' : 'switch');
    setSwitchError(undefined);
    setCreateError(undefined);
    try {
      const next = base
        ? await window.piskie.desktop.workspace.createBranch(info.path, branch, base)
        : await window.piskie.desktop.workspace.switchBranch(info.path, branch);
      if (request !== requestOwner.current.sequence) return false;
      setResult(readResult(next, revision));
      return true;
    } catch (cause) {
      if (request !== requestOwner.current.sequence) return false;
      const setError = base ? setCreateError : setSwitchError;
      setError(messageText(base ? 'sessionWorkbenchUi.composer.branchCreateFailed' : 'sessionWorkbenchUi.composer.branchSwitchFailed', {
        error: presentationFromError(cause, messageText('sessionWorkbenchUi.composer.workspaceUnavailable')),
      }));
      // Refresh external ref/HEAD changes without discarding the form's input or operation error.
      pendingRef.current = false;
      refresh();
      return false;
    } finally {
      pendingRef.current = false;
      if (request === requestOwner.current.sequence) setPending(undefined);
    }
  }, [info, refresh, revision]);

  return {
    info, error: result?.error, switchError, createError,
    loading: workspace !== null && result?.revision !== revision,
    switching: pending === 'switch', creating: pending === 'create', refresh,
    switchBranch: (branch: string) => changeBranch(branch),
    createBranch: (branch: string) => info?.git ? changeBranch(branch, info.git.head) : Promise.resolve(false),
    clearBranchErrors: () => { setSwitchError(undefined); setCreateError(undefined); },
  };
}
