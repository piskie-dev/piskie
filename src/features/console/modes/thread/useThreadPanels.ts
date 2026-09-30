import { useCallback, useState } from 'react';
import type { FileReviewTarget, UpdateFileReviewTarget } from '../../content/fileReviewTarget';
import { useReviewRequest } from '../../content/useReviewRequest';
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
  const { begin: beginReviewRequest, invalidate, isCurrentScope } = useReviewRequest(scope);
  const [views, setViews] = useState<ReadonlyMap<string, PanelView>>(() => new Map());
  const view = views.get(scope) ?? DEFAULT_VIEW;
  const update = useCallback((change: (current: PanelView) => PanelView) => {
    setViews((current) => new Map(current).set(scope, change(current.get(scope) ?? DEFAULT_VIEW)));
  }, [scope]);

  const open = useCallback((panel: PanelKey, reviewTarget?: FileReviewTarget) => {
    invalidate();
    update((current) => ({
      ...current,
      collapsed: false,
      wanted: panel,
      closed: current.closed.filter((key) => key !== panel),
      ...(reviewTarget && { reviewTarget }),
    }));
  }, [update, invalidate]);

  const close = useCallback((panel: PanelKey) => {
    invalidate();
    update((current) => ({
      ...current,
      closed: current.closed.includes(panel) ? current.closed : [...current.closed, panel],
      ...(panel === 'review' && { reviewTarget: undefined }),
    }));
  }, [update, invalidate]);

  const pick = useCallback((wanted: PanelKey) => {
    invalidate();
    update((current) => ({ ...current, wanted }));
  }, [update, invalidate]);

  const collapse = useCallback(() => {
    invalidate();
    update((current) => ({ ...current, collapsed: true }));
  }, [update, invalidate]);

  const expand = useCallback(() => {
    update((current) => ({ ...current, collapsed: false }));
  }, [update]);

  const updateReviewTarget = useCallback<UpdateFileReviewTarget>((expected, next) => {
    setViews((current) => {
      const existing = current.get(scope);
      if (!isCurrentScope() || existing?.reviewTarget?.kind !== 'path' || existing.reviewTarget !== expected || existing.reviewTarget.path !== expected.path) return current;
      return new Map(current).set(scope, { ...existing, reviewTarget: next ?? undefined });
    });
  }, [scope, isCurrentScope]);

  return { ...view, open, close, pick, collapse, expand, beginReviewRequest, updateReviewTarget };
}
