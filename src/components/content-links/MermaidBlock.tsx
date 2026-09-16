import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { CopyActionButton } from '@/components/shared/CopyActionButton';
import { copyImage, copyText } from '@/services/clipboard';
import { MarkdownImageContext } from './markdownImageContext';
import { mermaidToPng, renderMermaid, type MermaidDiagram, type MermaidTheme } from './mermaidRuntime';
import styles from './mermaidBlock.module.css';

function readTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function MermaidBlock({ source, complete }: { readonly source: string; readonly complete: boolean }) {
  const { t } = useTranslation();
  const { onPreviewImage } = useContext(MarkdownImageContext);
  const theme = useSyncExternalStore<MermaidTheme>(subscribeTheme, readTheme, () => 'dark');
  const [view, setView] = useState<'diagram' | 'source'>('diagram');
  const identity = useMemo(() => ({ source, theme, complete }), [source, theme, complete]);
  const copyIdentity = useMemo(() => ({ source, view, theme }), [source, view, theme]);
  const [result, setResult] = useState<{
    identity: typeof identity;
    diagram?: MermaidDiagram;
    failed: boolean;
  }>();
  const current = result?.identity === identity ? result : undefined;
  const diagram = current?.diagram;
  const previewIdentity = useMemo(() => ({ diagram, view, onPreviewImage }), [diagram, view, onPreviewImage]);
  const previewRequest = useRef<symbol>();
  const [preview, setPreview] = useState<{ identity: typeof previewIdentity; status: 'opening' | 'error' }>();
  const previewStatus = preview?.identity === previewIdentity ? preview.status : undefined;

  useEffect(() => () => { previewRequest.current = undefined; }, [previewIdentity]);

  const openPreview = async () => {
    if (!diagram || !onPreviewImage || previewRequest.current) return;
    const request = Symbol();
    previewRequest.current = request;
    setPreview({ identity: previewIdentity, status: 'opening' });
    try {
      const png = await mermaidToPng(diagram);
      if (previewRequest.current !== request) return;
      const url = URL.createObjectURL(png);
      const release = () => URL.revokeObjectURL(url);
      // The existing preview owns this PNG even if the Markdown block disappears.
      try { onPreviewImage(url, [url], 0, release, 'diagram.png'); }
      catch (error) { release(); throw error; }
      setPreview(undefined);
    } catch {
      if (previewRequest.current === request) setPreview({ identity: previewIdentity, status: 'error' });
    } finally {
      if (previewRequest.current === request) previewRequest.current = undefined;
    }
  };

  useEffect(() => {
    if (!complete) return;
    let active = true;
    void renderMermaid(source, theme).then(
      (rendered) => { if (active) setResult({ identity, diagram: rendered, failed: false }); },
      () => { if (active) setResult({ identity, failed: true }); },
    );
    return () => { active = false; };
  }, [source, theme, complete, identity]);

  return (
    <div className={styles.block} data-mermaid-view={view}>
      <div className={styles.toolbar}>
        <div className={styles.views}>
          <button type="button" aria-pressed={view === 'diagram'} onClick={() => setView('diagram')}>
            {t('mermaidUi.diagram')}
          </button>
          <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>
            {t('mermaidUi.source')}
          </button>
        </div>
        <CopyActionButton
          className={styles.copy}
          contentKey={copyIdentity}
          label={view === 'source' ? t('mermaidUi.copySource') : t('clipboardUi.copyImage')}
          disabled={view === 'diagram' && !diagram}
          onCopy={async () => {
            if (view === 'source') await copyText(source);
            else if (diagram) await copyImage({ kind: 'blob', blob: await mermaidToPng(diagram), name: 'diagram.png' });
          }}
        />
      </div>
      {view === 'source' ? (
        <pre className={styles.source}><code>{source}</code></pre>
      ) : diagram ? (
        <>
          <div
            className={styles.diagram}
            role={onPreviewImage ? 'button' : undefined}
            tabIndex={onPreviewImage ? 0 : undefined}
            aria-label={onPreviewImage ? t('sharedUi.markdownImage.preview', { description: t('mermaidUi.diagram') }) : undefined}
            aria-busy={previewStatus === 'opening' || undefined}
            onClick={onPreviewImage ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              void openPreview();
            } : undefined}
            onKeyDown={onPreviewImage ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              void openPreview();
            } : undefined}
          >
            <img className={styles.image} data-image-preview="display-only" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram.svg)}`} alt={t('mermaidUi.diagram')} />
          </div>
          {previewStatus === 'error' && <div className={styles.message} role="alert">{t('sharedUi.markdownImage.failed')}</div>}
        </>
      ) : (
        <div className={styles.message} role={current?.failed ? 'alert' : 'status'}>
          {current?.failed ? t('mermaidUi.renderFailed') : t('mermaidUi.rendering')}
        </div>
      )}
    </div>
  );
}
