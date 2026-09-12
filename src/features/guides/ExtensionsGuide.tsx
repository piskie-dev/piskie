import { useEffect, useState } from 'react';
import { AutoGuide } from './AutoGuide';

export function ExtensionsGuide({ pageReady, blocked, onAction }: { readonly pageReady: boolean; readonly blocked: boolean; readonly onAction: () => void }) {
  const [empty, setEmpty] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    // A filtered list (or built-in skills) is not evidence of prior user installations.
    void window.piskie.capabilities.market.installed({ scopes: ['user', 'project'], kinds: ['skill', 'plugin'], limit: 1 })
      .then((page) => { if (alive) setEmpty(page.total === 0); })
      .catch(() => { /* Failed reads must not be mistaken for a new user. */ });
    return () => { alive = false; };
  }, []);
  return <AutoGuide id="extensions" ready={pageReady && empty !== null} eligible={empty === true} blocked={blocked} onAction={onAction} />;
}
