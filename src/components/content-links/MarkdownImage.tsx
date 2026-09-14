import type { ComponentProps } from '@ant-design/x-markdown';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useImagePreviewUrl } from '../../hooks/useImagePreviewUrl';
import { resolveLocalPath } from '../../utils/localPath';
import { renderedImageContext, type ImagePreviewHandler } from '../image-preview/renderedImageContext';
import { ContentLink } from './ContentLinks';
import { targetFromHref } from './scanTargets';
import styles from './markdownImage.module.css';

export interface MarkdownImageOptions {
  readonly baseDirectory?: string;
  readonly onPreviewImage?: ImagePreviewHandler;
}

const MarkdownImageContext = createContext<MarkdownImageOptions>({});

export function MarkdownImageProvider({ options, children }: { options: MarkdownImageOptions; children: ReactNode }) {
  return <MarkdownImageContext.Provider value={options}>{children}</MarkdownImageContext.Provider>;
}

export function MarkdownImage(props: ComponentProps) {
  const { 'data-image-src': markdownSrc, src: htmlSrc, alt = '', title } = props as ComponentProps & {
    'data-image-src'?: string;
    src?: string;
    alt?: string;
    title?: string;
  };
  const src = markdownSrc ?? htmlSrc ?? '';
  const { t } = useTranslation();
  const { baseDirectory, onPreviewImage } = useContext(MarkdownImageContext);
  const target = targetFromHref(src);
  const path = target?.kind === 'path' ? resolveLocalPath(target.value, baseDirectory) : null;
  const file = useImagePreviewUrl(path ?? undefined);
  const url = target?.kind === 'url' ? target.value : file.url;
  const [loaded, setLoaded] = useState<{ url: string | null; status: 'loading' | 'ready' | 'error' }>({ url, status: 'loading' });
  const current = loaded.url === url;
  if (!current) setLoaded({ url, status: 'loading' });
  const imageRef = useRef<HTMLImageElement>(null);
  const failed = !target || (target.kind === 'path' && (!path || file.status === 'error'))
    || (current && loaded.status === 'error');
  const ready = !!url && current && loaded.status === 'ready';
  const description = alt || title || t('sharedUi.markdownImage.alt');
  const preview = () => {
    if (!ready || !imageRef.current) return;
    const context = renderedImageContext(imageRef.current);
    onPreviewImage?.(url, context.urls, context.index);
  };

  return (
    <span className={styles.image}>
      {failed ? (
        <span className={styles.placeholder} role="status">
          <span>{t('sharedUi.markdownImage.failed')} · {description}</span>
          {target && (target.kind === 'url' || path) ? (
            <ContentLink kind={target.kind} target={path ?? target.value}>{path ?? target.value}</ContentLink>
          ) : <span>{src}</span>}
        </span>
      ) : (
        <>
          {!ready && <span className={styles.placeholder} role="status">{t('sharedUi.markdownImage.loading')} · {description}</span>}
          {url && (
            <span
              className={styles.preview}
              role={onPreviewImage ? 'button' : undefined}
              tabIndex={onPreviewImage && ready ? 0 : undefined}
              aria-label={onPreviewImage ? t('sharedUi.markdownImage.preview', { description }) : undefined}
              hidden={!ready}
              onClick={onPreviewImage ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                preview();
              } : undefined}
              onKeyDown={onPreviewImage ? (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                preview();
              } : undefined}
            >
              <img
                key={url}
                ref={imageRef}
                className={styles.picture}
                src={url}
                alt={description}
                title={title}
                hidden={!ready}
                onLoad={() => setLoaded({ url, status: 'ready' })}
                onError={() => setLoaded({ url, status: 'error' })}
              />
            </span>
          )}
        </>
      )}
    </span>
  );
}
