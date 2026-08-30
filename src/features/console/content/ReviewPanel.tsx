/**
 * ReviewPanel —— 单条文件操作的「看这一次改了什么」。thread 装在右栏；dock 装在 Dialog。
 *
 * 点流水里的「编辑文件」条目，直接展开的是参数 JSON 原文（`{ "old_string": "<canvas
 * id=\\"game-canvas\\"…" }` 转义符满屏），读不出改了什么。这里换成：顶部一行文件名 + `+a -b`，
 * 下面是带行号的着色 diff —— **只呈现被点那一条消息本次的改动**，不聚合、不罗列该文件的其它轮次。
 *
 * ## 展示对象
 *
 * | 对象 | 形态 |
 * |---|---|
 * | 一次 write/edit | 单个文件名 + 本次 diff（着色、带行号） |
 * | 读取的文本文件 | Markdown 文档，或带真实行号的只读代码视图 |
 * | 正文里的本地路径 | 当前磁盘快照；Markdown 渲染成文档，其余文本显示源码 |
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

import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Binary, Check, Copy, ExternalLink, FolderOpen, Image as ImageIcon, Music, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LinkedMarkdown } from '@/components/content-links';
import { collapseContext, type DiffLine } from '../data/diffLines';
import { grammarForPath, tokenize, MAX_HIGHLIGHT_LINES, type Token } from './diff/highlight';
import { basename, type FileChange, type ReadOp } from '../data/review';
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
 * 没有可复制文本(二进制/缺失)时不出复制钮。复制成功图标换勾 1.5s。
 */
const HeaderActions = memo<{
  readonly copyText: string | null;
  readonly path: string;
  readonly onRevealPath: (path: string) => void;
}>(({ copyText, path, onRevealPath }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async (): Promise<void> => {
    if (copyText === null) return;
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className={styles.headerActions}>
      {copyText !== null && (
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => void copy()}
          title={copied ? t('sessionWorkbenchUi.review.copied') : t('sessionWorkbenchUi.review.copyContent')}
          aria-label={t('sessionWorkbenchUi.review.copyContent')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
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
  readonly reason: string;
  readonly onOpenPath: (path: string) => void;
  readonly onRevealPath: (path: string) => void;
}>(({ path, reason, onOpenPath, onRevealPath }) => {
  const { t } = useTranslation();
  return <div className={styles.card}>
    <span className={styles.cardIcon}>{kindIcon(path)}</span>
    <div className={styles.cardMain}>
      <span className={styles.cardName} title={path}>
        {basename(path)}
      </span>
      <span className={styles.cardReason}>{reason}</span>
      <div className={styles.cardActions}>
        <button type="button" className={styles.cardButton} onClick={() => onOpenPath(path)}>
          <ExternalLink size={11} />
          <span>{t('sessionWorkbenchUi.review.openWithSystem')}</span>
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
        <div key={index} className={styles.line} data-kind="context">
          <span className={styles.lineNo}>{startLine + index}</span>
          <span className={styles.sign}> </span>
          <CodeLine text={text} tokens={tokens[index]} />
        </div>
      ))}
    </div>
  );
});

ReadCode.displayName = 'ReadCode';

/** 文件快照按类型展示；Markdown 走文档视图，其余文本走带行号源码视图。 */
const TextPreview = memo<{
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
}>(({ path, content, startLine }) => (
  grammarForPath(path) === 'markdown' ? (
    <div className={`${styles.markdown} markdown-dark-theme`}>
      <LinkedMarkdown>{content}</LinkedMarkdown>
    </div>
  ) : (
    <ReadCode path={path} content={content} startLine={startLine} />
  )
));

TextPreview.displayName = 'TextPreview';

const ReadView = memo<{
  readonly op: ReadOp;
  readonly onOpenPath: (path: string) => void;
  readonly onRevealPath: (path: string) => void;
}>(({ op, onOpenPath, onRevealPath }) => {
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

  return <TextPreview path={op.path} content={op.content} startLine={op.startLine ?? 1} />;
});

ReadView.displayName = 'ReadView';

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
  readonly onOpenPath: (path: string) => void;
  readonly onRevealPath: (path: string) => void;
}

export const ReviewPanel = memo<ReviewPanelProps>(
  ({ change, read, preview, onOpenPath, onRevealPath }) => {
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
      const size = descriptor.size < 1024
        ? `${descriptor.size} B`
        : descriptor.size < 1024 * 1024
          ? `${(descriptor.size / 1024).toFixed(1)} KB`
          : `${(descriptor.size / 1024 / 1024).toFixed(2)} MB`;

      return (
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.headerTitle} title={path}>{basename(path)}</span>
            <span className={styles.headerHint}>{t('sessionWorkbenchUi.review.preview')}</span>
            <HeaderActions copyText={text} path={path} onRevealPath={onRevealPath} />
          </div>
          <div className={styles.scroll}>
            {descriptor.kind === 'file' ? (
              <FileCard
                path={path}
                reason={t('sessionWorkbenchUi.review.previewUnavailableDetail', { type, size })}
                onOpenPath={onOpenPath}
                onRevealPath={onRevealPath}
              />
            ) : (
              <>
                {descriptor.truncated && (
                  <div className={styles.notice}>{t('sessionWorkbenchUi.review.truncatedPreview')}</div>
                )}
                <TextPreview path={path} content={descriptor.content} startLine={1} />
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
            <ReadView op={read} onOpenPath={onOpenPath} onRevealPath={onRevealPath} />
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
