/**
 * Transcript —— 流水列表。
 *
 * 三条约定：
 *
 * 1. **不用 JS 虚拟化**：`content-visibility: auto` + `contain-intrinsic-size` 在 CSS 层跳过
 *    离屏 cell 的 layout/paint；DOM 完整，不存在挂载/卸载抖动，因此条目也不需要入场动画
 *    （决策：无条目入场动画）。
 * 2. **初始定位交给 CSS**：`scroll-initial-target: nearest` 落在最后一条上，
 *    布局阶段完成，不写 `useEffect` + `scrollTop` + 双层 rAF。
 * 3. **粘底是唯一保留的滚动 JS**：抽到 `useStickToBottom`。
 *
 * 视口内最近 `NEAR_VIEWPORT_COUNT` 条不加 `content-visibility`——指导明确要求
 * 不要对首屏元素用 `auto`（会让浏览器先评估可见性边界，反而更慢）。
 */

import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TranscriptNode } from '@/domains/transcript/nodes';
import type { TranscriptResponse } from '@/domains/transcript/types';
import { buildTranscriptRows, type TranscriptProcessBoundaries } from '../data/transcriptRows';
import type { WorkerRef } from '../data/vm';
import { TranscriptRow } from './TranscriptRow';
import { useStickToBottom } from './useStickToBottom';
import { readScrollMemory, saveScrollMemory } from './scrollMemory';
import {
  mergeTranscriptProcessBoundaries,
  readTranscriptOpenGroups,
  readTranscriptProcessBoundaries,
  setTranscriptGroupOpen,
} from './transcriptPresentationMemory';
import { AgentActivityRow } from './AgentActivityRow';
import styles from './Transcript.module.css';

/** 尾部这么多条不做 defer */
const NEAR_VIEWPORT_COUNT = 30;
const NO_RESPONSES: readonly TranscriptResponse[] = [];

/**
 * react-flow 的行为豁免标记（**全局类名，不是 CSS module**，项目里无任何样式规则命中）。
 *
 * dock 画布上的 worker 节点内部就是这份流水。不加这三个类的话：
 * - 缺 `nowheel` ⇒ 在流水上滚滚轮**缩放整个画布**，而不是滚动流水
 * - 缺 `nodrag`  ⇒ 在流水里按下拖动**会拖走节点**，选不了文本
 * - 缺 `nopan`   ⇒ 同上的平移变体
 *
 * **画布外（thread / dock 固定列）这三个类完全惰性**，所以放在共享组件里没有副作用。
 */
const RF_SCROLL = 'nodrag nopan nowheel';

export interface TranscriptProps {
  readonly nodes: readonly TranscriptNode[];
  readonly responses?: readonly TranscriptResponse[];
  /** Current activity has ended without interruption or a pending user decision. */
  readonly processSettled?: boolean;
  readonly toolsActive?: boolean;
  readonly workers?: readonly WorkerRef[];
  readonly renderNode: (node: TranscriptNode) => React.ReactNode;
  readonly hasEarlier?: boolean;
  readonly onLoadEarlier?: () => void;
  readonly emptyText?: string;
  readonly activeStartedAt?: number;
  /**
   * 是否提供"回到底部"浮钮（thread 用；依 Codex 截图它**只在上翻时出现**）。
   * 放在这里而不是外层：滚动状态由本组件持有，外层拿不到，
   * 上提状态会引入一个每次滚动都要同步的 prop。
   */
  readonly scrollAffordance?: boolean;
  /**
   * 运行期展示与滚动位置驻留键(按目标)。调用方以目标为 key 重挂本组件后,
   * 再次挂载恢复过程边界、展开选择和滚动位置——主/子各记各的。
   */
  readonly memoryKey?: string;
}

const TranscriptImpl = forwardRef<HTMLDivElement, TranscriptProps>(
  (
    {
      nodes,
      responses = NO_RESPONSES,
      processSettled = false,
      toolsActive = false,
      workers,
      renderNode,
      hasEarlier,
      onLoadEarlier,
      emptyText,
      activeStartedAt,
      scrollAffordance,
      memoryKey,
    },
    forwardedRef,
  ) => {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const processBoundaries = useRef<TranscriptProcessBoundaries>(
      memoryKey ? readTranscriptProcessBoundaries(memoryKey) ?? new Map() : new Map(),
    );
    const { rows, boundaries } = useMemo(
      () => buildTranscriptRows(nodes, responses, processSettled && activeStartedAt === undefined, processBoundaries.current),
      [nodes, responses, processSettled, activeStartedAt],
    );
    // Retain only boundaries from committed renders; rows always use the current transcript nodes.
    useLayoutEffect(() => {
      processBoundaries.current = memoryKey
        ? mergeTranscriptProcessBoundaries(memoryKey, boundaries, nodes.map((node) => node.id))
        : boundaries;
    }, [boundaries, memoryKey, nodes]);
    const activeToolGroupId = useMemo(() => {
      if (!toolsActive) return undefined;
      // A visible reply, user turn, or inline worker card ends the active tool interval.
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.kind === 'tools') return row.id;
        if (row.kind === 'process' || row.node.kind === 'assistant'
          || row.node.kind === 'user' || row.node.kind === 'worker') {
          return undefined;
        }
      }
      return undefined;
    }, [rows, toolsActive]);
    const deferredNodeIds = useMemo(
      () => new Set(nodes.slice(0, Math.max(0, nodes.length - NEAR_VIEWPORT_COUNT)).map((node) => node.id)),
      [nodes],
    );
    // Call IDs survive text streaming and canonical replacement, as well as outer process folding.
    const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
      () => memoryKey ? readTranscriptOpenGroups(memoryKey) ?? new Set() : new Set(),
    );
    // 外部要拿滚动容器（thread 的"回到底部"浮钮），但粘底仍由本组件持有
    useImperativeHandle(forwardedRef, () => scrollRef.current as HTMLDivElement, []);
    // 渲染期读驻留(模块内存,纯读):决定初始粘底与否;组件按 memoryKey 重挂,挂载期内不变
    const remembered = memoryKey ? readScrollMemory(memoryKey) : undefined;
    const { onScroll, scrollToBottom, preserveAnchor, atBottom } = useStickToBottom(
      scrollRef,
      contentRef,
      [rows, activeStartedAt, openGroups],
      { initialStick: remembered ? remembered.atBottom : true },
    );
    const toggleGroup = useCallback((id: string, anchor: HTMLElement) => {
      preserveAnchor(anchor);
      const open = !openGroups.has(id);
      if (memoryKey) {
        setOpenGroups(setTranscriptGroupOpen(memoryKey, id, open));
        return;
      }
      const next = new Set(openGroups);
      if (open) next.add(id);
      else next.delete(id);
      setOpenGroups(next);
    }, [memoryKey, openGroups, preserveAnchor]);

    /**
     * 滚动位置驻留:挂载时若该目标记过"非贴底"位置就原样恢复
     * (覆盖粘底 mount 效应与 scroll-initial-target 的初始落底;恢复触发的
     * scroll 事件会把粘底判定同步为 false),卸载时把当下位置记回去。
     * useLayoutEffect:恢复必须在首帧绘制前,否则会闪一下底部。
     */
    useLayoutEffect(() => {
      if (!memoryKey) return;
      // 挂载期内容器 DOM 不变:effect 内取一次,cleanup 用同一引用(卸载时 ref 可能已被清)
      const el = scrollRef.current;
      if (!el) return;
      const entry = readScrollMemory(memoryKey);
      if (entry && !entry.atBottom) el.scrollTop = entry.top;
      return () => {
        saveScrollMemory(memoryKey, {
          top: el.scrollTop,
          atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 40,
        });
      };
    }, [memoryKey]);

    /**
     * 滚动中标记：给容器打 `data-scrolling`，静止 1s 摘掉。
     * 直写 DOM 而不是 setState —— 滚动事件每帧都来，进 React 状态就是每帧重渲染。
     * CSS 消费它做滚动条"滚动才显示"。
     */
    const scrollingTimer = useRef<number | null>(null);
    const handleScroll = useCallback(
      (event: React.UIEvent<HTMLDivElement>) => {
        const el = event.currentTarget;
        el.dataset.scrolling = 'true';
        if (scrollingTimer.current !== null) window.clearTimeout(scrollingTimer.current);
        scrollingTimer.current = window.setTimeout(() => {
          delete el.dataset.scrolling;
          scrollingTimer.current = null;
        }, 1000);
        onScroll(event);
      },
      [onScroll],
    );
    useEffect(() => {
      return () => {
        if (scrollingTimer.current !== null) window.clearTimeout(scrollingTimer.current);
      };
    }, []);

    const deferBefore = Math.max(0, rows.length - NEAR_VIEWPORT_COUNT);

    return (
      <div className={styles.viewport}>
        <div
          ref={scrollRef}
          className={`${styles.transcript} ${RF_SCROLL}`}
          onScroll={handleScroll}
        >
          <div ref={contentRef} className={styles.content} data-image-preview-scope>
            {hasEarlier && onLoadEarlier && (
              <button type="button" className={styles.loadEarlier} onClick={onLoadEarlier}>
                {t('sessionWorkbenchUi.transcript.loadEarlier')}
              </button>
            )}

            {rows.map((row, index) => (
              <div
                key={row.id}
                className={styles.cell}
                data-deferred={index < deferBefore ? 'true' : undefined}
                data-node-id={row.kind === 'node' ? row.node.id : undefined}
              >
                <TranscriptRow
                  row={row}
                  renderNode={renderNode}
                  openGroups={openGroups}
                  deferredNodeIds={deferredNodeIds}
                  onToggle={toggleGroup}
                  toolsActive={row.id === activeToolGroupId}
                  workers={workers}
                />
              </div>
            ))}

            {nodes.length === 0 && activeStartedAt === undefined && (
              <div className={styles.empty}>{emptyText ?? t('sessionWorkbenchUi.transcript.empty')}</div>
            )}
            {activeStartedAt !== undefined && (
              <AgentActivityRow activeStartedAt={activeStartedAt} />
            )}
          </div>
        </div>

        {/* 只在上翻时出现（Codex 的行为）；恒显示会让人不知道它是干什么的 */}
        {scrollAffordance && !atBottom && (
          <button
            type="button"
            className={styles.scrollToBottom}
            onClick={scrollToBottom}
            aria-label={t('sessionWorkbenchUi.transcript.returnToBottom')}
          >
            <ArrowDown size={14} />
          </button>
        )}
      </div>
    );
  },
);

TranscriptImpl.displayName = 'Transcript';

export const Transcript = memo(TranscriptImpl);
