import { useEffect, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LinkedMarkdown } from '@/components/content-links';
import { CopyActionButton } from '@/components/shared/CopyActionButton';
import { useCopyAction } from '@/hooks/useCopyAction';
import { copyImage, copyText } from '@/services/clipboard';
import type { ContentBlock, Message, ToolResultContentBlock } from '@shared/types';
import { safeJson } from './ledger-projection';
import styles from './context-inspector.module.css';

export function MessageBlocks({ message }: { readonly message: Message }) {
  if (typeof message.content === 'string') {
    return <TextBlock text={message.content} />;
  }
  return (
    <div className={styles.blockStack}>
      {message.content.map((block, index) => (
        <ContextBlock key={`${block.type}:${index}`} block={block} index={index} />
      ))}
    </div>
  );
}

function ContextBlock({ block, index }: {
  readonly block: ContentBlock | ToolResultContentBlock;
  readonly index: number;
}) {
  const { t } = useTranslation();
  const value = block as ContentBlock & Record<string, unknown>;
  switch (value.type) {
    case 'text':
      return <TextBlock text={value.text ?? ''} index={index} />;
    case 'tool_use':
      return (
        <BlockFrame label="tool_use" accent="call" index={index} copyValue={safeJson(value)}>
          <KeyValue label="name" value={value.name ?? 'unknown'} />
          <KeyValue label="call id" value={value.id ?? '—'} mono />
          <JsonValue value={value.input ?? {}} />
        </BlockFrame>
      );
    case 'tool_result': {
      const result = value.content;
      return (
        <BlockFrame
          label={value.is_error ? 'tool_result · error' : 'tool_result · success'}
          accent={value.is_error ? 'error' : 'result'}
          index={index}
          copyValue={safeJson(value)}
        >
          <KeyValue label="call id" value={value.tool_use_id ?? '—'} mono />
          {typeof result === 'string' ? (
            <TextBlock text={result} nested />
          ) : (
            <div className={styles.nestedBlocks}>
              {(result ?? []).map((child, childIndex) => (
                <ContextBlock
                  key={`${child.type}:${childIndex}`}
                  block={child}
                  index={childIndex}
                />
              ))}
            </div>
          )}
        </BlockFrame>
      );
    }
    case 'image':
      return <ImageBlock block={value} index={index} />;
    case 'thinking':
      return (
        <BlockFrame label="thinking" accent="thinking" index={index} copyValue={value.thinking ?? ''}>
          <TextBlock text={value.thinking ?? ''} nested />
          <OpaqueLength label="signature" value={value.signature} />
        </BlockFrame>
      );
    case 'redacted_thinking':
      return (
        <BlockFrame label="redacted_thinking" accent="muted" index={index} copyValue={safeJson(value)}>
          <p className={styles.opaqueNotice}>{t('contextUi.blocks.hiddenReasoning')}</p>
          <OpaqueLength label="data" value={value.data} />
        </BlockFrame>
      );
    case 'openai_reasoning':
      return (
        <BlockFrame label="openai_reasoning" accent="thinking" index={index} copyValue={safeJson(value)}>
          <div className={styles.kvGrid}>
            <KeyValue label="status" value={value.status ?? '—'} />
            <KeyValue label="provider item" value={value.provider_item_id ?? '—'} mono />
          </div>
          {(value.summary ?? []).map((part, partIndex) => (
            <TextBlock key={`summary:${partIndex}`} text={part.text} nested />
          ))}
          {(value.reasoning_content ?? []).map((part, partIndex) => (
            <TextBlock key={`reasoning:${partIndex}`} text={part.text} nested />
          ))}
          <OpaqueLength label="encrypted content" value={value.encrypted_content} />
        </BlockFrame>
      );
    default:
      return (
        <BlockFrame
          label={`unknown · ${String(value.type ?? 'missing type')}`}
          accent="muted"
          index={index}
          copyValue={safeJson(value)}
        >
          <JsonValue value={value} />
        </BlockFrame>
      );
  }
}

function TextBlock({ text, index, nested = false }: {
  readonly text: string;
  readonly index?: number;
  readonly nested?: boolean;
}) {
  return (
    <BlockFrame
      label="text"
      accent="text"
      index={index}
      copyValue={text}
      nested={nested}
    >
      <div className={styles.markdown}><LinkedMarkdown>{text || ' '}</LinkedMarkdown></div>
    </BlockFrame>
  );
}

function ImageBlock({ block, index }: {
  readonly block: ContentBlock;
  readonly index: number;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ source: ContentBlock['source']; url: string } | null>(null);
  const source = block.source;
  const previewUrl = preview?.source === source ? preview?.url : null;
  const metadata = source
    ? `${source.media_type} · ${formatBytes(Math.floor(source.data.length * 0.75))}`
    : t('contextUi.blocks.missingImageSource');

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const togglePreview = () => {
    if (previewUrl) {
      setPreview(null);
      return;
    }
    if (!source) return;
    setPreview({ source, url: URL.createObjectURL(createImageBlob(source.data, source.media_type)) });
  };

  return (
    <BlockFrame label="image" accent="image" index={index} copyLabel={t('contextUi.blocks.copyImageMetadata')} copyValue={safeJson({
      type: 'image',
      media_type: source?.media_type,
      base64Chars: source?.data.length ?? 0,
    })}>
      <div className={styles.imageMeta}>
        <ImageIcon size={16} />
        <span>{metadata}</span>
        <CopyActionButton
          className={styles.inlineAction}
          contentKey={source}
          label={t('clipboardUi.copyImage')}
          disabled={!source}
          onCopy={() => copyImage({ kind: 'blob', blob: createImageBlob(source!.data, source!.media_type) })}
        />
        <button type="button" className={styles.inlineAction} onClick={togglePreview} disabled={!source}>
          {previewUrl ? <EyeOff size={14} /> : <Eye size={14} />}
          {previewUrl ? t('contextUi.blocks.hidePreview') : t('contextUi.blocks.showPreview')}
        </button>
      </div>
      {previewUrl && <img className={styles.imagePreview} src={previewUrl} alt={t('contextUi.blocks.imageAlt')} />}
    </BlockFrame>
  );
}

function BlockFrame({
  label,
  accent,
  index,
  copyValue,
  copyLabel,
  nested,
  children,
}: {
  readonly label: string;
  readonly accent: 'text' | 'call' | 'result' | 'error' | 'thinking' | 'image' | 'muted';
  readonly index?: number;
  readonly copyValue: string;
  readonly copyLabel?: string;
  readonly nested?: boolean;
  readonly children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <article className={styles.block} data-accent={accent} data-nested={nested || undefined}>
      <header className={styles.blockHeader}>
        <span>{index === undefined ? label : `${String(index).padStart(2, '0')} / ${label}`}</span>
        <CopyButton value={copyValue} label={copyLabel ?? t('contextUi.blocks.copyNamed', { name: label })} />
      </header>
      <div className={styles.blockBody}>{children}</div>
    </article>
  );
}

export function CopyButton({ value, label }: {
  readonly value: string;
  readonly label?: string;
}) {
  const { t } = useTranslation();
  const { busy, status, run } = useCopyAction(value);
  const resolvedLabel = label ?? t('contextUi.blocks.copy');
  const feedback = status === 'success' ? t('contextUi.blocks.copied')
    : status === 'error' ? t('clipboardUi.copyFailed')
      : status === 'copying' ? t('clipboardUi.copying') : t('contextUi.blocks.copy');
  return (
    <button
      type="button"
      className={styles.copyButton}
      onClick={() => { void run(() => copyText(value)); }}
      disabled={busy}
      aria-busy={busy}
      aria-label={resolvedLabel}
      title={feedback}
    >
      <Copy size={13} />
      <span aria-live="polite">{feedback}</span>
    </button>
  );
}

function JsonValue({ value }: { readonly value: unknown }) {
  const json = useMemo(() => safeJson(value), [value]);
  return <pre className={styles.json}>{json}</pre>;
}

function KeyValue({ label, value, mono = false }: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className={styles.keyValue}>
      <span>{label}</span>
      <strong data-mono={mono || undefined}>{value}</strong>
    </div>
  );
}

function OpaqueLength({ label, value }: { readonly label: string; readonly value?: string }) {
  const { t, i18n } = useTranslation();
  if (value === undefined) return null;
  const count = value.length.toLocaleString(i18n.resolvedLanguage ?? i18n.language);
  return <KeyValue label={label} value={t('contextUi.blocks.opaqueChars', { count })} mono />;
}

function createImageBlob(base64: string, mediaType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mediaType });
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
