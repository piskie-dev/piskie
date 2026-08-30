import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Download, PackageOpen } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type KernelPhase = 'download' | 'verify' | 'extract' | 'done' | 'error';

interface KernelProgress {
  hostKey: string;
  phase: KernelPhase;
  received?: number;
  total?: number;
  message?: string;
}

interface KernelStatus {
  hostKey: string;
  installed: boolean;
  hasAsset: boolean;
  version: string;
  progress?: KernelProgress;
}

function formatSize(bytes: number | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function downloadPercent(progress: KernelProgress | null): number | null {
  if (!progress?.total || progress.received == null) return null;
  return Math.min(100, Math.max(0, Math.floor((progress.received / progress.total) * 100)));
}

const KernelDownloadIndicator = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [progress, setProgress] = useState<KernelProgress | null>(null);
  const [showReady, setShowReady] = useState(false);

  const refresh = useCallback(async () => {
    const nextStatus = await window.piskie.pilot.environments.kernelStatus();
    setStatus(nextStatus);
    setProgress(nextStatus.installed ? null : nextStatus.progress ?? null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = window.piskie.pilot.environments.observeKernel((next) => {
      setProgress(next);

      if (next.phase === 'done') {
        setShowReady(true);
        void refresh();
      } else if (next.phase === 'error') {
        setStatus((current) => current ? { ...current, installed: false, progress: next } : current);
      }
    });

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (!showReady) return;
    const timer = window.setTimeout(() => setShowReady(false), 3000);
    return () => window.clearTimeout(timer);
  }, [showReady]);

  const percent = downloadPercent(progress);
  const received = formatSize(progress?.received);
  const total = formatSize(progress?.total);
  const unsupported = status != null && !status.installed && !status.hasAsset;
  const failed = progress?.phase === 'error' || unsupported;
  const active = progress?.phase === 'download'
    || progress?.phase === 'verify'
    || progress?.phase === 'extract'
    || (status != null && !status.installed && status.hasAsset && !failed);
  const visible = showReady || failed || active;

  const copy = useMemo(() => {
    if (showReady) {
      return {
        title: t('browserRuntime.installDone', 'Browser runtime is ready'),
        detail: status?.version.replace(/^fpc-/, '') || '',
      };
    }
    if (unsupported) {
      return {
        title: t('browserRuntime.unavailable', 'Unavailable on this platform'),
        detail: status?.hostKey || '',
      };
    }
    if (progress?.phase === 'error') {
      return {
        title: t('browserRuntime.installFailed', 'Browser runtime installation failed'),
        detail: t('browserRuntime.viewDetails', 'Open settings for details'),
      };
    }
    if (progress?.phase === 'verify') {
      return {
        title: t('browserRuntime.verifying', 'Verifying SHA256...'),
        detail: total || received || '',
      };
    }
    if (progress?.phase === 'extract') {
      return {
        title: t('browserRuntime.extracting', 'Extracting...'),
        detail: total || received || '',
      };
    }
    return {
      title: percent == null
        ? t('browserRuntime.preparing', 'Preparing browser runtime...')
        : t('browserRuntime.downloadingPercent', 'Browser runtime {{percent}}%', { percent }),
      detail: received && total ? `${received} / ${total}` : received || '',
    };
  }, [percent, progress, received, showReady, status, t, total, unsupported]);

  const determinateWidth = showReady
    ? 100
    : progress?.phase === 'download' && percent != null
      ? percent
      : 0;

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.2 }}
          onClick={() => navigate('/preferences?sect=kernel')}
          title={progress?.message || copy.title}
          className={`relative h-9 w-[230px] shrink-0 overflow-hidden rounded-xl border px-3 text-left transition-colors ${
            failed
              ? 'border-status-error/35 bg-status-error/10 hover:bg-status-error/15'
              : showReady
                ? 'border-status-running/35 bg-status-running/10'
                : 'border-cyber-primary/35 bg-cyber-primary/10 hover:bg-cyber-primary/15'
          }`}
          aria-label={`${copy.title}${copy.detail ? `, ${copy.detail}` : ''}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {failed ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-error" />
            ) : showReady ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-running" />
            ) : progress?.phase === 'extract' ? (
              <PackageOpen className="h-3.5 w-3.5 shrink-0 text-cyber-primary" />
            ) : (
              <Download className="h-3.5 w-3.5 shrink-0 text-cyber-primary" />
            )}
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[11px] font-medium text-cyber-text">
                {copy.title}
              </span>
              {copy.detail && (
                <span className="block truncate text-[10px] tabular-nums text-cyber-text-muted">
                  {copy.detail}
                </span>
              )}
            </span>
          </span>

          <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-white/5">
            {determinateWidth > 0 ? (
              <motion.span
                className={`block h-full ${showReady ? 'bg-status-running' : 'bg-cyber-primary'}`}
                animate={{ width: `${determinateWidth}%` }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              />
            ) : !failed ? (
              <motion.span
                className="block h-full w-1/3 bg-cyber-primary"
                animate={{ x: ['-100%', '300%'] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
              />
            ) : null}
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
};

export default KernelDownloadIndicator;
