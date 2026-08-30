import {
  createContext,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { getPrimaryModifierKey, hasPrimaryModifierKey } from '../../utils/platform';
import {
  scanContentTargets,
  type ContentTargetKind,
} from './scanTargets';
import styles from './contentLinks.module.css';

type TargetOpener = (target: string) => void | Promise<void>;

interface InternalOpeners {
  readonly openUrl?: TargetOpener;
  readonly openLocalHtml?: TargetOpener;
  readonly openLocalFile?: TargetOpener;
}

interface HintState {
  text: string;
  left: number;
  top: number;
  placement: 'above' | 'below';
}

type ContentLinkAction = ContentTargetKind | 'html' | 'file';

interface ContentLinkRuntime {
  showHint(anchor: HTMLElement, text: string): void;
  hideHint(): void;
  reportFailure(anchor: HTMLElement, action: ContentLinkAction, error: unknown): void;
}

const RuntimeContext = createContext<ContentLinkRuntime>({
  showHint: () => undefined,
  hideHint: () => undefined,
  reportFailure: (_anchor, action, error) => {
    console.error(`Failed to activate ${action} target`, error);
  },
});

const InternalOpenersContext = createContext<InternalOpeners>({});

function isLocalHtmlPath(target: string): boolean {
  return /\.html?$/i.test(target);
}

function modifierLabel(translate: (key: string) => string): string {
  return getPrimaryModifierKey() === 'cmd'
    ? translate('sharedUi.contentLink.commandClick')
    : translate('sharedUi.contentLink.controlClick');
}

export function ContentLinkHost({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const [hint, setHint] = useState<HintState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideHint = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHint(null);
  }, []);

  const showMessage = useCallback((anchor: HTMLElement, text: string, autoHide = false) => {
    const rect = anchor.getBoundingClientRect();
    const placement = rect.top >= 40 ? 'above' : 'below';
    const estimatedWidth = Math.min(320, Math.max(180, text.length * 12 + 16));
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - estimatedWidth - 4));
    const top = placement === 'above' ? rect.top - 6 : rect.bottom + 6;
    setHint({
      text,
      left,
      top,
      placement,
    });

    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = autoHide ? setTimeout(() => {
      hideTimer.current = null;
      setHint(null);
    }, 1800) : null;
  }, []);

  const reportFailure = useCallback((
    anchor: HTMLElement,
    action: ContentLinkAction,
    error: unknown,
  ) => {
    const label = action === 'url'
      ? t('sharedUi.contentLink.openLinkFailed')
      : action === 'html'
        ? t('sharedUi.contentLink.previewHtmlFailed')
        : action === 'file'
          ? t('sharedUi.contentLink.previewFileFailed')
          : t('sharedUi.contentLink.revealFileFailed');
    console.error(label, error);
    showMessage(anchor, label, true);
  }, [showMessage, t]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const runtime = useMemo<ContentLinkRuntime>(() => ({
    showHint: showMessage,
    hideHint,
    reportFailure,
  }), [hideHint, reportFailure, showMessage]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
      {hint && typeof document !== 'undefined' && createPortal(
        <div
          className={styles.hint}
          data-placement={hint.placement}
          style={{ left: hint.left, top: hint.top }}
          role="status"
        >
          {hint.text}
        </div>,
        document.body,
      )}
    </RuntimeContext.Provider>
  );
}

export function ContentLinkUrlScope({
  onOpenUrl,
  onOpenLocalHtml,
  onOpenLocalFile,
  children,
}: {
  onOpenUrl?: TargetOpener;
  onOpenLocalHtml?: TargetOpener;
  onOpenLocalFile?: TargetOpener;
  children?: ReactNode;
}) {
  const openers = useMemo<InternalOpeners>(() => ({
    openUrl: onOpenUrl,
    openLocalHtml: onOpenLocalHtml,
    openLocalFile: onOpenLocalFile,
  }), [onOpenLocalFile, onOpenLocalHtml, onOpenUrl]);
  return <InternalOpenersContext.Provider value={openers}>{children}</InternalOpenersContext.Provider>;
}

export interface ContentLinkProps {
  kind: ContentTargetKind;
  target: string;
  children?: ReactNode;
}

export function ContentLink({ kind, target, children }: ContentLinkProps) {
  const { t } = useTranslation();
  const runtime = useContext(RuntimeContext);
  const internalOpeners = useContext(InternalOpenersContext);
  const openLocalHtml = kind === 'path' && isLocalHtmlPath(target)
    ? internalOpeners.openLocalHtml
    : undefined;
  const openLocalFile = kind === 'path' ? internalOpeners.openLocalFile : undefined;
  const hintText = openLocalHtml
    ? t('sharedUi.contentLink.previewHtmlHint', { modifier: modifierLabel(t) })
    : openLocalFile
      ? t('sharedUi.contentLink.previewFileHint', { modifier: modifierLabel(t) })
    : t('sharedUi.contentLink.actionHint', {
      action: kind === 'url'
        ? t('sharedUi.contentLink.openLink')
        : t('sharedUi.contentLink.revealFile'),
      modifier: modifierLabel(t),
    });

  const showInteractionHint = useCallback((event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    runtime.showHint(event.currentTarget, hintText);
  }, [hintText, runtime]);

  const hideInteractionHint = useCallback(() => {
    runtime.hideHint();
  }, [runtime]);

  const activate = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (hasPrimaryModifierKey(event)) {
      const anchor = event.currentTarget;
      runtime.hideHint();
      const operation = kind === 'url'
        ? window.piskie.desktop.system.openExternal(target)
        : window.piskie.desktop.system.revealPath(target);
      void operation.catch((error) => runtime.reportFailure(anchor, kind, error));
      return;
    }

    const internalOpener = kind === 'url'
      ? internalOpeners.openUrl
      : (openLocalHtml ?? openLocalFile);
    if (internalOpener) {
      const anchor = event.currentTarget;
      runtime.hideHint();
      void Promise.resolve(internalOpener(target))
        .catch((error) => runtime.reportFailure(
          anchor,
          kind === 'path' ? (openLocalHtml ? 'html' : 'file') : kind,
          error,
        ));
      return;
    }

    runtime.showHint(event.currentTarget, hintText);
  }, [hintText, internalOpeners.openUrl, kind, openLocalFile, openLocalHtml, runtime, target]);

  const content = children ?? target;
  if (kind === 'url') {
    return (
      <a
        className={styles.target}
        data-content-target="url"
        href={target}
        onBlur={hideInteractionHint}
        onClick={activate}
        onFocus={showInteractionHint}
        onMouseEnter={showInteractionHint}
        onMouseLeave={hideInteractionHint}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={styles.target}
      data-content-target="path"
      data-target={target}
      onBlur={hideInteractionHint}
      onClick={activate}
      onFocus={showInteractionHint}
      onMouseEnter={showInteractionHint}
      onMouseLeave={hideInteractionHint}
    >
      {content}
    </button>
  );
}

/** Renders all URL and absolute-path matches while preserving the original text verbatim. */
export function LinkedText({ children }: { children: string }) {
  const targets = useMemo(() => scanContentTargets(children), [children]);
  if (targets.length === 0) return <>{children}</>;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const target of targets) {
    if (target.start > cursor) nodes.push(children.slice(cursor, target.start));
    nodes.push(
      <ContentLink
        key={`${target.start}:${target.end}`}
        kind={target.kind}
        target={target.value}
      />,
    );
    cursor = target.end;
  }
  if (cursor < children.length) nodes.push(children.slice(cursor));
  return <>{nodes}</>;
}
