/**
 * ReviewPanel —— 单条文件操作的「看这一次改了什么」。thread 装在右栏；dock 装在 Dialog。
 *
 * 点流水里的「编辑文件」条目，直接展开的是参数 JSON 原文（`{ "edits": [{ "old_string": "<canvas
 * id=\\"game-canvas\\"…" }` 转义符满屏），读不出改了什么。这里换成：顶部一行文件名 + `+a -b`，
 * 下面是带行号的着色 diff —— **只呈现被点那一条消息本次的改动**，不聚合、不罗列该文件的其它轮次。
 *
 * ## 展示对象
 *
 * | 对象 | 形态 |
 * |---|---|
 * | 一次 write/edit | 单个文件名 + 本次 diff（着色、带行号） |
 * | 读取的文本文件 | 带源文件行号的 Markdown 文档或只读代码视图 |
 * | 正文里的本地路径 | 文本展示当前磁盘快照；目录展示信息卡与系统动作 |
 * | 读不了的文件（二进制 / 超大 / 缺失） | **文件卡**：类型图标 + 原因 + 两个系统动作 |
 *
 * 二进制没有可读文本形态，硬渲染只会得到乱码。与其显示乱码，不如把它当**文件**呈现 ——
 * 给「在 Finder 中显示」与「用系统应用打开」两个出口（失败文案里的 mime/大小由后端给）。
 *
 * ## 行号
 *
 * `write` 与带权威 diff 的 `edit` 有真实行号；裸参数重建的 `edit` 只有 hunk，
 * **不知道落在文件第几行**，于是行号槽显示 `·`。宁可空着也不画假行号。
 */

import React, { memo, useMemo } from 'react';
import { Binary, Check, Copy, ExternalLink, FolderOpen, Image as ImageIcon, Music, TriangleAlert, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LinkedMarkdown, type SourceBlockProps } from '@/components/content-links';
import { useCopyAction } from '@/hooks/useCopyAction';
import { copyText } from '@/services/clipboard';
import type { ImagePreviewHandler } from '@/components/image-preview/renderedImageContext';
import { localPathDirectory } from '@/utils/localPath';
import { collapseContext, type DiffLine } from '../data/diffLines';
import { grammarForPath, tokenize, MAX_HIGHLIGHT_LINES, type Token } from './diff/highlight';
import { basename, fileChangeOf, type FileChange, type ReadOp } from '../data/review';
import type { RoundFileChanges } from '../data/fileChanges';
import { resolvePresentationText } from '../data/presentationText';
import type { ReviewableFilePreview } from './fileReviewTarget';
import styles from './review.module.css';

/** 二进制文件卡的图标：按扩展名粗分四类，认不出用通用二进制图标 */
function kindIcon(path: string): React.ReactNode {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/.test(ext)) return <ImageIcon size={18} />;
  if (/\.(mp3|wav|ogg|flac|aac|m4a)$/.test(ext)) return <Music size={18} />;
  if (/\.(mp4|webm|avi|mov|mkv)$/.test(ext)) return <Video size={18} />;
  return <Binary size={18} />;
}


/**
 * 头部动作簇:复制内容 + 在文件夹中显示。
 * 复制源由调用侧给(read=文件内容原文;write/edit=本次 diff 文本);
 * 没有可复制文本(二进制/缺失)时不出复制钮。复制成功短暂显示勾选图标。
 */
const HeaderActions = memo<{
  readonly copyText: string | null;
  readonly path: string;
  readonly onRevealPath: (path: string) => void;
}>(({ copyText: textToCopy, path, onRevealPath }) => {
  const { t } = useTranslation();
  const contentKey = useMemo(() => ({ path, textToCopy }), [path, textToCopy]);
  const { busy, status, run } = useCopyAction(contentKey);
  const label = status === 'success' ? t('sessionWorkbenchUi.review.copied')
    : status === 'error' ? t('clipboardUi.copyFailed')
      : status === 'copying' ? t('clipboardUi.copying') : t('sessionWorkbenchUi.review.copyContent');

  return (
    <span className={styles.headerActions}>
      {textToCopy !== null && (
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => { void run(() => copyText(textToCopy)); }}
          disabled={busy}
          aria-busy={busy}
          title={label}
          aria-label={label}
        >
          {status === 'success' ? <Check size={12} /> : status === 'error' ? <TriangleAlert size={12} /> : <Copy size={12} />}
        </button>
      )}
      <button
        type="button"
        className={styles.headerButton}
        onClick={() => onRevealPath(path)}
        title={t('sessionWorkbenchUi.review.showInFolder')}
        aria-label={t('sessionWorkbenchUi.review.showInFolder')}
      >
        <FolderOpen size={12} />
      </button>
    </span>
  );
});

HeaderActions.displayName = 'ReviewHeaderActions';

function StatText({ added, removed }: { readonly added: number; readonly removed: number }): React.ReactNode {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <span className={styles.stat}>
      {added > 0 && <span className={styles.added}>+{added.toLocaleString(locale)}</span>}
      {removed > 0 && <span className={styles.removed}>-{removed.toLocaleString(locale)}</span>}
      {added === 0 && removed === 0 && (
        <span className={styles.zero}>{t('sessionWorkbenchUi.review.noChanges')}</span>
      )}
    </span>
  );
}

/**
 * 一行代码。有 token 就按 `data-tok` 分片着色，没有就退回纯文本。
 * 色值全部在 CSS 的 `[data-tok='…']` 上，TSX 里零色值。空行给零宽空格兜底，否则行高塌成 0。
 */
const CodeLine = memo<{ readonly text: string; readonly tokens?: readonly Token[] }>(
  ({ text, tokens }) => {
    if (!tokens || tokens.length === 0) {
      return <span className={styles.lineText}>{text || '​'}</span>;
    }
    return (
      <span className={styles.lineText}>
        {tokens.map((token, index) => (
          <span key={index} data-tok={token.kind === 'plain' ? undefined : token.kind}>
            {token.text}
          </span>
        ))}
      </span>
    );
  },
);

CodeLine.displayName = 'CodeLine';

// ==================== diff 视图 ====================

const DiffBody = memo<{
  readonly lines: readonly DiffLine[];
  readonly absoluteLines: boolean;
}>(({ lines, absoluteLines }) => {
  const { t } = useTranslation();
  const rows = useMemo(() => collapseContext(lines), [lines]);

  return (
    <div className={styles.code}>
      {rows.map((row, index) => {
        if ('skipped' in row) {
          return (
            <div key={`skip-${index}`} className={styles.skip}>
              {t('sessionWorkbenchUi.review.omittedLines', { count: row.skipped })}
            </div>
          );
        }
        return (
          <div key={index} className={styles.line} data-kind={row.kind}>
            <span className={styles.lineNo}>
              {absoluteLines ? (row.newNo ?? row.oldNo ?? '') : '·'}
            </span>
            <span className={styles.sign}>
              {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}
            </span>
            <CodeLine text={row.text} tokens={row.tokens} />
          </div>
        );
      })}
    </div>
  );
});

DiffBody.displayName = 'DiffBody';

// ==================== 单文件查看（read） ====================

const FileCard = memo<{
  readonly path: string;
  readonly kind?: 'file' | 'directory';
  readonly reason: string;
  readonly onOpenPath: (path: string) => void;
  readonly onRevealPath: (path: string) => void;
}>(({ path, kind = 'file', reason, onOpenPath, onRevealPath }) => {
  const { t } = useTranslation();
  return <div className={styles.card}>
    <span className={styles.cardIcon}>{kind === 'directory' ? <FolderOpen size={18} /> : kindIcon(path)}</span>
    <div className={styles.cardMain}>
      <span className={styles.cardName} title={path}>
        {basename(path)}
      </span>
      <span className={styles.cardReason}>{reason}</span>
      <div className={styles.cardActions}>
        <button type="button" className={styles.cardButton} onClick={() => onOpenPath(path)}>
          <ExternalLink size={11} />
          <span>{t(kind === 'directory' ? 'sessionWorkbenchUi.review.openDirectory' : 'sessionWorkbenchUi.review.openWithSystem')}</span>
        </button>
        <button type="button" className={styles.cardButton} onClick={() => onRevealPath(path)}>
          <FolderOpen size={11} />
          <span>{t('sessionWorkbenchUi.review.showInFolder')}</span>
        </button>
      </div>
    </div>
  </div>;
});

FileCard.displayName = 'FileCard';

/** 所有文本预览共用源行号栏；一个渲染块可以对应一行或多行源码。 */
const ReadBlock = memo<SourceBlockProps>(({ startLine, endLine, children }) => (
  <div className={styles.readBlock} data-source-start={startLine} data-source-end={endLine}>
    <span className={styles.sourceLineNo} aria-hidden>
      {startLine === endLine ? startLine : `${startLine}–${endLine}`}
    </span>
    <div className={styles.readContent}>{children}</div>
  </div>
));

ReadBlock.displayName = 'ReadBlock';

/** 读取的文本文件：整篇分词后逐行渲染，行号用文件里的真实行号 */
const ReadCode = memo<{
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
}>(({ path, content, startLine }) => {
  const lines = useMemo(() => content.split('\n'), [content]);
  // 与 diff 侧同一个闸门：超大文件不着色，避免上万个 span（见 `highlight.ts`）
  const tokens = useMemo(
    () => (lines.length > MAX_HIGHLIGHT_LINES ? [] : tokenize(content, grammarForPath(path))),
    [content, lines.length, path],
  );

  return (
    <div className={styles.code}>
      {lines.map((text, index) => (
        <ReadBlock key={index} startLine={startLine + index} endLine={startLine + index}>
          <CodeLine text={text} tokens={tokens[index]} />
        </ReadBlock>
      ))}
    </div>
  );
});

ReadCode.displayName = 'ReadCode';

/** 预览布局与行号共用；格式只决定正文如何渲染和映射到源文件行。 */
const TextPreview = memo<{
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly onPreviewImage?: ImagePreviewHandler;
}>(({ path, content, startLine, onPreviewImage }) => {
  const markdown = grammarForPath(path) === 'markdown';
  const digits = String(startLine + content.split('\n').length - 1).length;
  return (
    <div
      className={markdown ? `${styles.markdown} markdown-dark-theme` : styles.textPreview}
      data-image-preview-scope
      style={{ '--review-line-width': `calc(${markdown ? digits * 2 + 1 : digits}ch + 20px)` } as React.CSSProperties}
    >
      {markdown ? (
        <LinkedMarkdown
          sourceBlocks={{ startLine, component: ReadBlock }}
          baseDirectory={localPathDirectory(path)}
          onPreviewImage={onPreviewImage}
        >{content}</LinkedMarkdown>
      ) : (
        <ReadCode path={path} content={content} startLine={startLine} />
      )}
    </div>
  );
});

TextPreview.displayName = 'TextPreview';

const ReadView = memo<{
  readonly op: ReadOp;
  readonly onOpenPath: (path: string) => void;
  readonly onRevealPath: (path: string) => void;
  readonly onPreviewImage?: ImagePreviewHandler;
}>(({ op, onOpenPath, onRevealPath, onPreviewImage }) => {
  const { t } = useTranslation();
  if (op.content === undefined) {
    // 图片/二进制不在这里预览：read 图片的缩略图由流水里的工具行直接展示，
    // 审阅面只给文件卡（元信息 + 系统动作），不做重复的看图面。
    return (
      <FileCard
        path={op.path}
        reason={op.unreadable
          ? resolvePresentationText(op.unreadable, (key, values) => t(key, values ?? {}))
          : t('sessionWorkbenchUi.review.previewUnavailable')}
        onOpenPath={onOpenPath}
        onRevealPath={onRevealPath}
      />
    );
  }

  return <TextPreview path={op.path} content={op.content} startLine={op.startLine ?? 1} onPreviewImage={onPreviewImage} />;
});

ReadView.displayName = 'ReadView';

/** One file in one turn, preserving the diff and line-number boundary of every call. */
export const RecordedFileReview = memo<{
  readonly file: RoundFileChanges;
  readonly roundTitle: string;
  readonly onRevealPath: (path: string) => void;
}>(({ file, roundTitle, onRevealPath }) => {
  const { t } = useTranslation();
  const changes = useMemo(() => file.records.flatMap((record) => {
    const change = fileChangeOf(record.node);
    return change ? [{ id: record.id, change }] : [];
  }), [file.records]);
  const copyText = useMemo(() => changes.map(({ change }, index) => [
    t('sessionWorkbenchUi.review.recordedCall', { index: index + 1 }),
    ...change.diff.lines.map((line) => (line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ') + line.text),
  ].join('\n')).join('\n\n'), [changes, t]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerTitle} title={file.path}>
          {roundTitle && <span className={styles.roundTitle}>{roundTitle}</span>}
          {basename(file.path)}
        </span>
        <StatText added={file.added} removed={file.removed} />
        <HeaderActions copyText={copyText} path={file.path} onRevealPath={onRevealPath} />
      </div>
      <div className={styles.scroll}>
        {changes.map(({ id, change }, index) => (
          <section key={id} aria-label={t('sessionWorkbenchUi.review.recordedCall', { index: index + 1 })}>
            <div className={styles.callHeader}>
              <span>{t('sessionWorkbenchUi.review.recordedCall', { index: index + 1 })}</span>
              <StatText added={change.stat.added} removed={change.stat.removed} />
            </div>
            {change.diff.degraded && <div className={styles.notice}>{t('sessionWorkbenchUi.review.oversizedDiff')}</div>}
            <DiffBody lines={change.diff.lines} absoluteLines={change.absoluteLines} />
          </section>
        ))}
      </div>
    </div>
  );
});

RecordedFileReview.displayName = 'RecordedFileReview';

// ==================== 出口 ====================

export interface PathPreview {
  readonly path: string;
  readonly descriptor: ReviewableFilePreview;
}

export interface ReviewPanelProps {
  /** 被点的这条是 write/edit ⇒ 本次改动的单份 diff */
  readonly change: FileChange | null;
  /** 被点的这条是 read ⇒ 文件内容 / 文件卡 */
  readonly read: ReadOp | null;
  /** 正文里的本地路径 ⇒ 当前磁盘内容 / 文件卡 */
  readonly preview: PathPreview | null;
  readonly onPreviewImage?: ImagePreviewHandler;
  readonly onOpenPath: (path: string) => void;
  readonly onRevealPath: (path: string) => void;
}

export const ReviewPanel = memo<ReviewPanelProps>(
  ({ change, read, preview, onOpenPath, onRevealPath, onPreviewImage }) => {
    const { t } = useTranslation();
    /** write/edit 的复制源:本次 diff 的文本形态(+/-/空格前缀,不含行号) */
    const diffText = useMemo(() => {
      if (!change) return null;
      return change.diff.lines
        .map((line) => (line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ') + line.text)
        .join('\n');
    }, [change]);

    if (preview) {
      const { descriptor, path } = preview;
      const text = descriptor.kind === 'text' ? descriptor.content : null;
      const type = descriptor.kind === 'file'
        ? (descriptor.mediaType ?? t('sessionWorkbenchUi.review.binaryFile'))
        : null;
      const fileSize = descriptor.kind === 'file' ? descriptor.size : null;
      const size = fileSize === null ? null : fileSize < 1024
        ? `${fileSize} B`
        : fileSize < 1024 * 1024
          ? `${(fileSize / 1024).toFixed(1)} KB`
          : `${(fileSize / 1024 / 1024).toFixed(2)} MB`;

      return (
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.headerTitle} title={path}>{basename(path)}</span>
            <span className={styles.headerHint}>{t('sessionWorkbenchUi.review.preview')}</span>
            <HeaderActions copyText={text} path={path} onRevealPath={onRevealPath} />
          </div>
          <div className={styles.scroll}>
            {descriptor.kind !== 'text' ? (
              <FileCard
                path={path}
                kind={descriptor.kind}
                reason={descriptor.kind === 'directory'
                  ? t('sessionWorkbenchUi.review.directoryPreviewUnavailable')
                  : t('sessionWorkbenchUi.review.previewUnavailableDetail', { type, size })}
                onOpenPath={onOpenPath}
                onRevealPath={onRevealPath}
              />
            ) : (
              <>
                {descriptor.truncated && (
                  <div className={styles.notice}>{t('sessionWorkbenchUi.review.truncatedPreview')}</div>
                )}
                <TextPreview path={path} content={descriptor.content} startLine={1} onPreviewImage={onPreviewImage} />
              </>
            )}
          </div>
        </div>
      );
    }

    if (read) {
      return (
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.headerTitle} title={read.path}>
              {basename(read.path)}
            </span>
            <span className={styles.headerHint}>{t('sessionWorkbenchUi.review.read')}</span>
            <HeaderActions
              copyText={read.content ?? null}
              path={read.path}
              onRevealPath={onRevealPath}
            />
          </div>
          <div className={styles.scroll}>
            <ReadView op={read} onOpenPath={onOpenPath} onRevealPath={onRevealPath} onPreviewImage={onPreviewImage} />
          </div>
        </div>
      );
    }

    if (change) {
      return (
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.headerTitle} title={change.path}>
              {change.name}
            </span>
            <StatText added={change.stat.added} removed={change.stat.removed} />
            <HeaderActions
              copyText={diffText}
              path={change.path}
              onRevealPath={onRevealPath}
            />
          </div>
          <div className={styles.scroll}>
            {change.diff.degraded && (
              <div className={styles.notice}>{t('sessionWorkbenchUi.review.oversizedDiff')}</div>
            )}
            <DiffBody lines={change.diff.lines} absoluteLines={change.absoluteLines} />
          </div>
        </div>
      );
    }

    return <div className={styles.empty}>{t('sessionWorkbenchUi.review.emptyHint')}</div>;
  },
);

ReviewPanel.displayName = 'ReviewPanel';
