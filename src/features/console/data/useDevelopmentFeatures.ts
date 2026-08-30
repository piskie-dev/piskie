import { useEffect, useState } from 'react';

let cachedDevelopmentFeatures: boolean | undefined;
let pendingDevelopmentFeatures: Promise<boolean> | undefined;

async function requestDevelopmentFeatures(): Promise<boolean> {
  const piskie = typeof window === 'undefined' ? undefined : window.piskie;
  if (piskie?.runtime.host !== 'electron') return false;

  try {
    return await piskie.configuration.settings.developmentFeatures();
  } catch {
    return false;
  }
}

function loadDevelopmentFeatures(): Promise<boolean> {
  if (cachedDevelopmentFeatures !== undefined) {
    return Promise.resolve(cachedDevelopmentFeatures);
  }
  pendingDevelopmentFeatures ??= requestDevelopmentFeatures().then((value) => {
    cachedDevelopmentFeatures = value;
    return value;
  });
  return pendingDevelopmentFeatures;
}

export function useDevelopmentFeatures(): boolean {
  const [enabled, setEnabled] = useState(() => cachedDevelopmentFeatures ?? false);

  useEffect(() => {
    let cancelled = false;
    void loadDevelopmentFeatures().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
