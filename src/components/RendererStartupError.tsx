import { useTranslation } from 'react-i18next';
import type { AppSettings } from '@shared/types';
import { TopLevelErrorView } from './TopLevelErrorView';

interface RendererStartupErrorProps {
  error: unknown;
  language?: AppSettings['language'];
}

export function RendererStartupError({
  error,
  language = 'en-US',
}: RendererStartupErrorProps) {
  const { t } = useTranslation(undefined, { lng: language });

  return (
    <TopLevelErrorView
      eyebrow={t('topLevelError.runtimeUnavailable')}
      title={t('topLevelError.rendererStartupTitle')}
      detail={String(error)}
    />
  );
}
