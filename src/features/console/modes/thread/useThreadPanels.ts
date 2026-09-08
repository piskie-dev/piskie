import { useCallback, useState } from 'react';
import type { FileReviewTarget } from '../../content/fileReviewTarget';
import type { PanelKey } from './panels';

interface PanelView {
  readonly collapsed: boolean;
  readonly wanted: PanelKey;
  readonly closed: readonly PanelKey[];
  readonly reviewTarget?: FileReviewTarget;
}

const DEFAULT_VIEW: PanelView = { collapsed: false, wanted: 'review', closed: [] };

/** Each conversation tab remembers its own panel selection and visibility. */
export function useThreadPanels(scope: string) {
  const [views, setViews] = useState<ReadonlyMap<string, PanelView>>(() => new Map());
  const view = views.get(scope) ?? DEFAULT_VIEW;
  const update = useCallback((change: (current: PanelView) => PanelView) => {
    setViews((current) => new Map(current).set(scope, change(current.get(scope) ?? DEFAULT_VIEW)));
  }, [scope]);

  const open = useCallback((panel: PanelKey, reviewTarget?: FileReviewTarget) => {
    update((current) => ({
      ...current,
      collapsed: false,
      wanted: panel,
      closed: current.closed.filter((key) => key !== panel),
      ...(reviewTarget && { reviewTarget }),
    }));
  }, [update]);

  const close = useCallback((panel: PanelKey) => {
    update((current) => ({
      ...current,
      closed: current.closed.includes(panel) ? current.closed : [...current.closed, panel],
      ...(panel === 'review' && { reviewTarget: undefined }),
    }));
  }, [update]);

  const pick = useCallback((wanted: PanelKey) => {
    update((current) => ({ ...current, wanted }));
  }, [update]);

  const collapse = useCallback(() => {
    update((current) => ({ ...current, collapsed: true }));
  }, [update]);

  const expand = useCallback(() => {
    update((current) => ({ ...current, collapsed: false }));
  }, [update]);

  return { ...view, open, close, pick, collapse, expand };
}
