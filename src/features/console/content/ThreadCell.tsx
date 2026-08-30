/**
 * ThreadCell —— **两个模式共用的 cell 呈现**。
 *
 * 依据用户提供的 Codex 桌面应用截图，形态规律是：
 *
 * - **只有聚合产物配卡片**（diff / 计划正文）；单步动作一律是「图标 + 一行灰字」
 * - 用户消息是**右对齐圆角气泡**；AI 正文是**无容器满宽文本**
 * - 轮次摘要压成 `已处理 1m 17s ›` 一行
 *
 * **两个模式共用这一套横条阅读流**，交互也一致（就地展开、文件操作送审阅面）。
 * 因此本文件连同 `thread.module.css` / `ReviewPanel` / `ReviewSlot` 都在共享层 `content/`
 * ——eslint 的"模式互不参照"边界不允许 dock 直接引 thread，共用即共享层，不开豁免。
 *
 * **共享的是数据层**：同一份会话投影产物、同一套 `TranscriptNode` 判别联合。
 * 这里只决定"长什么样"，不重新解释语义。
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Camera,
  ChevronRight,
  CircleHelp,
  CircleSlash2,
  ClipboardList,
  FileDiff,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  FolderOpen,
  FolderSearch,
  Globe,
  Hourglass,
  ImagePlus,
  ListChecks,
  Loader2,
  Network,
  Puzzle,
  Search,
  Send,
  ShieldQuestion,
  Smartphone,
  Terminal,
  Workflow,
  Wrench,
  XCircle,
} from 'lucide-react';

import { LinkedMarkdown, LinkedText } from '@/components/content-links';
import { isMacOSPlatform } from '@/utils/platform';
import { ImageThumbnail } from './ImageThumbnail';
import { OrbIndicator } from './OrbIndicator';
import type { QuestionAnswerItem, ToolCellArtifact } from '../data/toolArtifacts';
import {
  isPresentationText,
  resolvePresentationText,
  type PresentationText,
} from '../data/presentationText';
import type {
  TranscriptNode,
  TranscriptAction,
  TranscriptBadge,
  TranscriptTone,
  DetailFormat,
  NoticeNode,
  ThinkNode,
  ToolNode,
} from '@/domains/transcript/nodes';
import styles from './thread.module.css';
import { StreamingMarkdown } from './StreamingMarkdown';
import { isBrowserToolName } from '../data/cells/toolPresentation';

const ICON = 14;

const BADGE_KEYS: Record<TranscriptBadge, string> = {
  running: 'transcript.badge.running',
  'awaiting-approval': 'transcript.badge.awaitingApproval',
  failed: 'transcript.badge.failed',
  cancelled: 'transcript.badge.cancelled',
};

/**
 * 「转入后台」的快捷键提示。平台判定复用 `utils/platform`（取主进程的真实
 * `process.platform`），不用 `navigator.platform`。
 * 与 `data/keyboard` 的 `mod`（Cmd 或 Ctrl 都匹配）同义。
 */
const SHORTCUT_HINT = isMacOSPlatform() ? '⌘B' : 'Ctrl+B';

/** 工具行的前置图标：与 Codex 的「描边小图标」气质一致，按状态而非语气选 */
/**
 * 工具语义图标：每类操作有自己的脸，终端符只留给真正的 shell。
 * 精确名优先，前缀/模式兜底；认不出的用扳手（通用工具），不冒充命令行。
 */
function toolGlyph(tool: string): React.ReactNode {
  switch (tool) {
    case 'read': return <FileText size={ICON} />;
    case 'write': return <FilePlus2 size={ICON} />;
    case 'edit': return <FilePen size={ICON} />;
    case 'ls': return <FolderOpen size={ICON} />;
    case 'glob': return <FolderSearch size={ICON} />;
    case 'grep': return <FileSearch size={ICON} />;
    case 'shell': return <Terminal size={ICON} />;
    case 'task': return <ListChecks size={ICON} />;
    case 'plan': return <ClipboardList size={ICON} />;
    case 'ask_user': return <CircleHelp size={ICON} />;
    case 'subagent': return <Workflow size={ICON} />;
    case 'send_event': return <Send size={ICON} />;
    case 'skill_call': return <Puzzle size={ICON} />;
    case 'load_skill': return <BookOpen size={ICON} />;
    case 'tool_search': return <Search size={ICON} />;
    case 'generate_image': return <ImagePlus size={ICON} />;
    case 'wait': return <Hourglass size={ICON} />;
    default:
      if (/screenshot/i.test(tool)) return <Camera size={ICON} />;
      if (tool.startsWith('mobile-core')) return <Smartphone size={ICON} />;
      if (isBrowserToolName(tool)) return <Globe size={ICON} />;
      if (/write|edit|patch|apply/i.test(tool)) return <FilePen size={ICON} />;
      return <Wrench size={ICON} />;
  }
}

function toolIcon(cell: ToolNode): React.ReactNode {
  switch (cell.state.phase) {
    case 'running':
      return <Loader2 size={ICON} className="animate-spin" />;
    case 'awaiting-approval':
      return <ShieldQuestion size={ICON} />;
    case 'failed':
      return <XCircle size={ICON} />;
    case 'cancelled':
      return <CircleSlash2 size={ICON} />;
    case 'ok':
      return toolGlyph(cell.tool);
  }
}

/**
 * 一行灰字的动作行。两种点击语义，互斥：
 * - `detail`：就地缩进展开详情（默认）
 * - `onActivate`：把展示交给别人（文件操作 ⇒ 右栏审阅面板），本行不展开
 */
const ActionLine = memo<{
  readonly icon: React.ReactNode;
  readonly text: string;
  readonly state?: 'failed' | 'cancelled';
  readonly tone?: TranscriptTone;
  readonly badge?: TranscriptBadge;
  readonly detail?: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly onActivate?: () => void;
  /**
   * 行尾附加动作（目前只有「转入后台」）。**不能塞进主按钮里** —— button 套 button
   * 是非法 HTML；有 aside 时整行外面才包一层 flex 行，没有时不多包这一层。
   */
  readonly aside?: React.ReactNode;
}>(({ icon, text, state, tone, badge, detail, defaultOpen = false, onActivate, aside }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const clickable = !!onActivate || !!detail;

  const line = (
    <button
      type="button"
      className={styles.actionLine}
      data-state={state}
      data-tone={tone}
      data-clickable={clickable ? 'true' : undefined}
      aria-expanded={!onActivate && detail ? open : undefined}
      onClick={onActivate ?? (detail ? toggle : undefined)}
    >
      <span className={styles.actionIcon}>{icon}</span>
      <span className={styles.actionText}>{text}</span>
      {badge && <span className={styles.actionBadge}>{t(BADGE_KEYS[badge])}</span>}
      {clickable && (
        <span className={styles.chevron}>
          <ChevronRight size={12} />
        </span>
      )}
    </button>
  );

  return (
    <>
      {/* 详情**必须留在 flex 行之外**，否则展开的正文会被挤成一列 */}
      {aside ? (
        <div className={styles.toolRow}>
          {line}
          {aside}
        </div>
      ) : (
        line
      )}

      {!onActivate && detail && open && <div className={styles.inlineDetail}>{detail}</div>}
    </>
  );
});

ActionLine.displayName = 'ActionLine';

function noticeIcon(cell: NoticeNode): React.ReactNode {
  if (cell.tone === 'danger') return <XCircle size={ICON} />;
  if (cell.badge === 'cancelled') return <CircleSlash2 size={ICON} />;
  return <FileText size={ICON} />;
}

// ==================== 详情 format renderer registry ====================

type DetailRenderer = (value: unknown, onPreviewImage?: (src: string) => void) => React.ReactNode;

/** text/code/json 的既有形态：字符串原样、其余 JSON 序列化，经 LinkedText 输出 */
function renderPlainValue(value: unknown): React.ReactNode {
  return (
    <span className={styles.plainValue}>
      <LinkedText>
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </LinkedText>
    </span>
  );
}

function renderMarkdownValue(value: unknown): React.ReactNode {
  if (typeof value !== 'string') return renderPlainValue(value);
  return (
    <div className="markdown-dark-theme">
      <LinkedMarkdown>
        {value}
      </LinkedMarkdown>
    </div>
  );
}

/** 逐题问答（`ask_user_answers` 投影）：React 文本节点输出，换行由 CSS 保留 */
function renderQuestionAnswersValue(value: unknown): React.ReactNode {
  const items = value as readonly QuestionAnswerItem[];
  return (
    <div className={styles.qaList}>
      {items.map((item, index) => (
        <div key={index} className={styles.qaItem}>
          <div className={styles.qaQuestion}>{item.question}</div>
          <div className={styles.qaAnswer}>{item.answer}</div>
        </div>
      ))}
    </div>
  );
}

/** MCP 音频暂不进入模型结果，通过 Artifact 使用原生控件展示。 */
function renderAudioBlocksValue(value: unknown): React.ReactNode {
  const items = value as readonly Extract<ToolCellArtifact, { kind: 'mcp_audio' }>[];
  return (
    <div className={styles.audioList}>
      {items.map((item, index) => (
        <audio key={index} className={styles.audioPlayer} src={item.dataUrl} controls preload="metadata" />
      ))}
    </div>
  );
}

/**
 * 按 format 判别渲染，不检查工具名；新增 DetailFormat 而未注册时编译失败
 * （Record 的键穷尽由 TypeScript 保证）。
 */
const DETAIL_RENDERERS: Record<DetailFormat, DetailRenderer> = {
  text: renderPlainValue,
  code: renderPlainValue,
  json: renderPlainValue,
  markdown: renderMarkdownValue,
  question_answers: renderQuestionAnswersValue,
  audio_blocks: renderAudioBlocksValue,
};

const Detail = memo<{
  readonly cell: TranscriptNode;
  readonly onPreviewImage?: (src: string) => void;
}>(({ cell, onPreviewImage }) => {
  const { t } = useTranslation();
  const detail = useMemo(() => cell.detail?.(), [cell]);
  if (!detail || detail.sections.length === 0) return null;

  const presentValue = (format: DetailFormat, value: unknown): unknown => (
    (format === 'text' || format === 'markdown') && isPresentationText(value)
      ? resolvePresentationText(value, (key, values) => t(key, values ?? {}))
      : value
  );

  return (
    <>
      {detail.sections.map((section, index) => (
        <div key={index} className={styles.cardBody} style={{ padding: 0 }}>
          {DETAIL_RENDERERS[section.format](
            presentValue(section.format, section.value),
            onPreviewImage,
          )}
        </div>
      ))}
    </>
  );
});

Detail.displayName = 'ThreadCellDetail';

/**
 * 带边框卡片的**唯一**实现：卡头可点开合，正文收起时截断并在下缘淡出。
 *
 * thread 里只有"聚合产物"配卡片（任务分派、执行计划），而这类正文动辄铺满一屏、
 * 占掉整个可视区。所以卡片一律可收起，且**两处共用这一个组件** ——
 * 收起手势、截断高度、淡出效果只有一份，不会各自漂移。
 *
 * 收起用 `max-block-size` + 下缘 `mask-image` 而不是 `-webkit-line-clamp`：
 * 正文可能是渲染后的 markdown（标题、列表、代码块），line-clamp 要求
 * `display: -webkit-box`，会打乱内部块级布局。高度截断 + 淡出对两种内容都成立，
 * 而且"下面还有"这件事由淡出边缘直接表达，不需要额外文案。
 *
 * 展开动画走 `interpolate-size`（容器 `Transcript.module.css` 已开启），
 * `max-block-size` 从固定值过渡到 `max-content`，无需 JS 测高。
 */
const CollapsibleCard = memo<{
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly subtitle?: string;
  /** 待审批的内容必须默认展开——要你批就得让你看得见 */
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}>(({ icon, title, subtitle, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  return (
    <div className={styles.card}>
      <button type="button" className={styles.cardHeadButton} onClick={toggle} aria-expanded={open}>
        <span className={styles.cardIcon}>{icon}</span>
        <div className={styles.cardHeadMain}>
          <span className={styles.cardTitle}>{title}</span>
          {subtitle && <span className={styles.cardStat}>{subtitle}</span>}
        </div>
        <span className={styles.chevron}>
          <ChevronRight size={12} />
        </span>
      </button>

      <div className={styles.collapsibleBody} data-open={open ? 'true' : undefined}>
        {children}
      </div>
    </div>
  );
});

CollapsibleCard.displayName = 'CollapsibleCard';

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf('\n');
  return newline === -1 ? visible : visible.slice(newline + 1);
}

/** Think stays a one-line disclosure while streaming; the full Markdown is opt-in. */
const ThinkDisclosure = memo<{ readonly cell: ThinkNode }>(({ cell }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const summary = cell.live ? latestLine(cell.markdown) : firstLine(cell.markdown);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const toggleFromKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  }, [toggle]);

  useEffect(() => {
    const element = summaryRef.current;
    if (!element) return;
    const update = () => {
      element.scrollLeft = cell.live ? element.scrollWidth - element.clientWidth : 0;
    };
    const frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [cell.live, summary]);

  return (
    <div className={styles.thinkDisclosure} data-live={cell.live || undefined}>
      <div
        role="button"
        tabIndex={0}
        className={styles.thinkToggle}
        aria-expanded={open}
        data-think-toggle=""
        onClick={toggle}
        onKeyDown={toggleFromKeyboard}
      >
        {/* 活动图形只属于活动中（aicss Thinking/Orbs 同款语义）：
            思考中 = Orb 收放 + 标签流光；完成 = 前置开合箭头（disclosure 惯例），
            图形不随 hover 变化，位置恒定无闪烁 */}
        <span className={styles.thinkLeading} aria-hidden>
          {cell.live ? (
            <OrbIndicator size={14} variant="expanding" />
          ) : (
            <ChevronRight size={13} className={styles.thinkCaret} />
          )}
        </span>
        <span className={styles.thinkLabel}>
          {cell.live ? t('transcript.thinking') : t('transcript.title.thinking')}
        </span>
        {!open && (
          <>
            <span className={styles.thinkSeparator} aria-hidden />
            <div
              ref={summaryRef}
              className={styles.thinkSummary}
              data-follow-end={cell.live || undefined}
              data-think-summary=""
            >
              <StreamingMarkdown markdown={summary} live={cell.live} />
            </div>
          </>
        )}
      </div>

      {open && (
        <div className={styles.thinkBody} data-think-body="">
          <div className={`${styles.thinkMarkdown} markdown-dark-theme`}>
            <StreamingMarkdown markdown={cell.markdown} live={cell.live} />
          </div>
        </div>
      )}
    </div>
  );
});

ThinkDisclosure.displayName = 'ThinkDisclosure';

export interface ThreadCellProps {
  readonly cell: TranscriptNode;
  readonly onPreviewImage?: (src: string) => void;
  /** 点文件操作条目 ⇒ 右栏审阅面板显示它；不传则退回就地展开 */
  readonly onOpenFileChange?: (cellId: string) => void;
  /**
   * cell 声明的动作（目前只有执行中工具的「转入后台」）。
   * 与 `mod+b` 走同一个入口（`content/useActionScope`），键鼠语义不分叉。
   */
  readonly onAction?: (cell: TranscriptNode, action: TranscriptAction) => void;
}

export const ThreadCell = memo<ThreadCellProps>(({ cell, onPreviewImage, onOpenFileChange, onAction }) => {
  const { t } = useTranslation();
  const title = t(cell.titleKey, cell.titleArgs ?? {});
  const present = (value: PresentationText): string => (
    resolvePresentationText(value, (key, values) => t(key, values ?? {}))
  );
  const summary = cell.summary ? present(cell.summary) : undefined;
  const meta = cell.meta?.map(present);
  switch (cell.kind) {
    /**
     * 任务分派 / 父级下发**不是"你说的话"**，不能走右对齐气泡：
     * worker 的第一条分派消息是一整个工作包正文，铺成满屏气泡观感极差。
     * 所以走"标题 + 摘要 + 可展开详情"的聚合产物卡片：
     * 卡头一行 + 三行截断预览，点开才铺全文。
     */
    case 'user':
      if (cell.origin !== 'user') {
        return (
          <CollapsibleCard
            icon={<ClipboardList size={16} />}
            title={title}
            subtitle={meta && meta.length > 0 ? meta.join(' · ') : undefined}
          >
            <div className={styles.plainBody}>{cell.text || summary || ''}</div>
          </CollapsibleCard>
        );
      }

      return (
        <div className={styles.cell}>
          <div className={styles.userRow}>
            <div className={styles.bubble}>{cell.text || summary}</div>
          </div>

          {cell.images && cell.images.length > 0 && (
            <div className={styles.userMedia}>
              {cell.images.map((image, index) => {
                const key = image.kind === 'file' ? image.path : image.url;
                return (
                  <ImageThumbnail
                    key={`${key}:${index}`}
                    resource={image}
                    alt={t('sessionWorkbenchUi.transcript.attachmentImage')}
                    className={styles.userImage}
                    onPreview={onPreviewImage}
                  />
                );
              })}
            </div>
          )}
        </div>
      );

    // AI 正文：无容器满宽文本
    case 'assistant':
      return (
        <div className={`${styles.body} markdown-dark-theme`}>
          <StreamingMarkdown markdown={cell.markdown} live={cell.live} />
        </div>
      );

    case 'think':
      return <ThinkDisclosure cell={cell} />;

    // 工具：一行灰字，可就地展开
    case 'tool': {
      /**
       * 文件操作（read/write/edit）**不就地展开**：内联展开的是参数 JSON 原文，
       * 转义符满屏、读不出改了什么。改为把它送进右栏审阅面板，
       * 那里有带行号的着色 diff / 只读代码视图 / 二进制文件卡。
       */
      const toReview =
        cell.fileOp && onOpenFileChange ? () => onOpenFileChange(cell.id) : undefined;

      /**
       * 执行中的工具带「转入后台」。dock 早就有这个按钮，thread 一直没有任何入口，
       * 于是 `TranscriptAction` 在这个模式里只是数据、点不到（快捷键也一样，见 `useActionScope`）。
       */
      const action = onAction ? cell.actions.find((item) => item.enabled) : undefined;

      return (
        <div className={styles.cell}>
          <ActionLine
            icon={toolIcon(cell)}
            text={summary ? `${title} · ${summary}` : title}
            state={
              cell.state.phase === 'failed'
                ? 'failed'
                : cell.state.phase === 'cancelled'
                  ? 'cancelled'
                  : undefined
            }
            onActivate={toReview}
            detail={cell.interaction === 'none' ? undefined : <Detail cell={cell} onPreviewImage={onPreviewImage} />}
            aside={
              action && (
                <button
                  type="button"
                  className={styles.actionAside}
                  onClick={() => onAction?.(cell, action)}
                  title={t('transcript.action.promoteToBackgroundWithShortcut', {
                    shortcut: SHORTCUT_HINT,
                  })}
                >
                  {t('transcript.action.promoteToBackground')}
                </button>
              )
            }
          />

          {cell.generatedImages && (
            <div className={styles.imageRow}>
              {cell.generatedImages.map((path, index) => (
                <ImageThumbnail
                  key={`${path}:${index}`}
                  resource={{ kind: 'file', path }}
                  className={styles.imageThumb}
                  title={path}
                  alt={path}
                  onPreview={onPreviewImage}
                  fallback={<span className={styles.imagePath}>{path}</span>}
                />
              ))}
            </div>
          )}

          {(!cell.generatedImages || cell.generatedImages.length === 0) && cell.media && cell.media.length > 0 && (
            <div className={styles.imageRow}>
              {cell.media.map((image, index) => {
                const key = image.kind === 'file' ? image.path : image.url;
                return (
                  <ImageThumbnail
                    key={`${key}:${index}`}
                    resource={image}
                    className={styles.imageThumb}
                    alt={t('sessionWorkbenchUi.transcript.toolResultImage')}
                    onPreview={onPreviewImage}
                  />
                );
              })}
            </div>
          )}
        </div>
      );
    }

    // 计划正文：聚合产物 ⇒ 卡片（审批动作由贴底的 Gate 承载）
    case 'plan':
      return (
        <CollapsibleCard
          icon={<FileDiff size={16} />}
          title={t('transcript.title.executionPlan')}
          subtitle={cell.taskSummary}
          // 计划正文恒默认展开：它是会话的关键产物，收起反而要多点一下。
          // 仍可手动收起——「可收起」与「默认展开」不冲突。
          defaultOpen
        >
          {cell.body && (
            <div className={`${styles.cardBody} markdown-dark-theme`}>
              <LinkedMarkdown>
                {cell.body}
              </LinkedMarkdown>
            </div>
          )}
        </CollapsibleCard>
      );

    // 子流程创建：一行灰字
    case 'worker':
      return (
        <div className={styles.cell}>
          <ActionLine
            icon={<Network size={ICON} />}
            text={t('transcript.workerCreated', { subject: cell.subject })}
          />
        </div>
      );

    // 上下文压缩：一行灰字 + 可展开摘要
    case 'summary':
      return (
        <div className={styles.cell}>
          <ActionLine
            icon={<FileText size={ICON} />}
            text={title}
            detail={<Detail cell={cell} onPreviewImage={onPreviewImage} />}
          />
        </div>
      );

    case 'notice':
      return (
        <div className={styles.cell}>
          <ActionLine
            icon={noticeIcon(cell)}
            text={summary ? `${title} · ${summary}` : title}
            tone={cell.tone}
            badge={cell.badge}
            detail={cell.interaction === 'none' ? undefined : <Detail cell={cell} onPreviewImage={onPreviewImage} />}
            defaultOpen={cell.defaultExpanded}
          />
        </div>
      );
  }
});

ThreadCell.displayName = 'ThreadCell';
