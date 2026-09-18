import { Check, Copy, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopyAction } from '@/hooks/useCopyAction';
import styles from './CopyActionButton.module.css';

export interface CopyActionButtonProps {
  readonly contentKey: unknown;
  readonly onCopy: () => Promise<void>;
  readonly label: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly iconOnly?: boolean;
}

export function CopyActionButton({
  contentKey,
  onCopy,
  label,
  disabled,
  className,
  iconOnly = false,
}: CopyActionButtonProps) {
  const { t } = useTranslation();
  const { busy, status, run } = useCopyAction(contentKey);
  const text = status === 'copying' ? t('clipboardUi.copying')
    : status === 'success' ? t('clipboardUi.copied')
      : status === 'error' ? t('clipboardUi.copyFailed') : label;
  const Icon = status === 'copying' ? LoaderCircle
    : status === 'success' ? Check : status === 'error' ? TriangleAlert : Copy;

  return (
    <button
      type="button"
      className={className}
      onClick={() => { void run(onCopy); }}
      disabled={disabled || busy}
      aria-busy={busy}
      aria-label={text}
      title={text}
      data-copy-status={status}
    >
      <Icon size={14} aria-hidden="true" />
      <span className={iconOnly ? styles.visuallyHidden : undefined} aria-live="polite">{text}</span>
    </button>
  );
}
