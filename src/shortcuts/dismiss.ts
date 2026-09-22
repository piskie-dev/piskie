import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from 'react';

import { useShortcutScope } from './hooks';
import { ShortcutOverlayParentContext } from './overlayContext';
import type { ShortcutScope } from './types';

interface DismissShortcutScopeBase {
  readonly scopeIdPrefix: string;
  readonly active: boolean;
  readonly parentScopeId?: string;
  readonly blocksLowerLayers?: ShortcutScope['blocksLowerLayers'];
}

export type DismissShortcutScopeOptions = DismissShortcutScopeBase & (
  | {
      readonly handling?: 'execute';
      readonly onDismiss: () => void;
    }
  | {
      readonly handling: 'delegate-dismiss';
      readonly onDismiss?: never;
    }
);

/** Registers one Escape owner in the shared overlay stack. */
export function useDismissShortcutScope(options: DismissShortcutScopeOptions): string {
  const reactId = useId();
  const inheritedParentScopeId = useContext(ShortcutOverlayParentContext);
  const parentScopeId = options.parentScopeId ?? inheritedParentScopeId;
  const onDismissRef = useRef(options.onDismiss);
  useEffect(() => {
    onDismissRef.current = options.onDismiss;
  }, [options.onDismiss]);

  const scopeId = `${options.scopeIdPrefix}:${reactId}`;
  const handling = options.handling ?? 'execute';
  const blocksLowerLayers = options.blocksLowerLayers ?? 'none';
  const scope = useMemo<ShortcutScope>(() => ({
    id: scopeId,
    layer: 'overlay',
    parentScopeId,
    blocksLowerLayers,
    bindings: [handling === 'delegate-dismiss'
      ? {
          id: `${scopeId}:dismiss`,
          commandId: 'ui.dismissCurrentLayer',
          combo: 'escape',
          enabled: () => true,
          allowInEditable: true,
          handling: 'delegate-dismiss',
          defaultBehavior: 'preserve',
        }
      : {
          id: `${scopeId}:dismiss`,
          commandId: 'ui.dismissCurrentLayer',
          combo: 'escape',
          enabled: () => true,
          allowInEditable: true,
          handling: 'execute',
          defaultBehavior: 'prevent',
          execute: () => onDismissRef.current?.(),
        }],
  }), [blocksLowerLayers, handling, parentScopeId, scopeId]);

  useShortcutScope(scope, options.active);
  return scopeId;
}
