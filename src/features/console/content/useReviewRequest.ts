import { useCallback, useLayoutEffect, useRef } from 'react';

/** A path read may finish after another selection, scope switch, or panel dismissal. */
export function useReviewRequest(scope: string) {
  const owner = useRef({ active: false, sequence: 0, scope });
  useLayoutEffect(() => {
    const current = owner.current;
    current.active = true;
    current.scope = scope;
    current.sequence += 1;
    return () => { current.active = false; current.sequence += 1; };
  }, [scope]);

  const invalidate = useCallback(() => { owner.current.sequence += 1; }, []);
  const begin = useCallback(() => {
    const sequence = ++owner.current.sequence;
    return () => owner.current.active && owner.current.sequence === sequence;
  }, []);
  const isCurrentScope = useCallback(() => owner.current.active && owner.current.scope === scope, [scope]);
  return { begin, invalidate, isCurrentScope };
}
