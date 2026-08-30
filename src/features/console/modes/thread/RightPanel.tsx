/**
 * RightPanel —— 右栏辅助屏的壳。
 *
 * **内容随 agent tab 切换**：可用面板由目标 agent 的能力决定（`panels.ts` 纯函数），
 * 选中项「尽量保持同名」，目标没有该面板时回落第一个可用——纯派生，不用 effect 纠正。
 *
 * 缓存：按 `agent:panel` 做键，`content-visibility: hidden` 保 DOM 与滚动位置，
 * **配 LRU 上限 5**（只省 CPU 不省内存）。每个槽是独立组件，自己订阅自己的
 * agent（见 `RightPanelSlot`）——否则隐藏槽只能渲染空壳，缓存就只在同一 agent 内生效。
 *
 * ## 关栏的方式：**关 tab，不是按收起键**
 *
 * 右栏是 tab 形态，那么"收起"就该是 tab 的自然结果：每个 tab 可关，
 * **关到没有 tab 时整栏自动消失**。文件、浏览器等内容入口会在用户再次打开内容时
 * 恢复对应 tab，不另设无明确目标的通用展开按钮。
 *
 * 可见 tab 的清单与关闭集都由模式层（`ThreadMode`）持有：它要用同一份信息决定整栏出不出。
 */

import React, { memo, useCallback, useMemo } from 'react';
import { FileDiff, Globe, Monitor, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TopRail } from '../../chrome/TopRail';
import { useLruCache } from '../../data/useLruCache';
import type { WorkerVM } from '../../data/vm';
import { BrowserPanel } from './BrowserPanel';
import type { FileReviewTarget } from '../../content/fileReviewTarget';
import { resolveSelectedPanel, type PanelKey } from './panels';
import { ReviewSlot } from '../../content/ReviewSlot';
import { RightPanelSlot } from './RightPanelSlot';
import styles from './rightPanel.module.css';

/** 缓存槽上限 */
const CACHE_LIMIT = 5;

const PANEL_META: Record<PanelKey, { labelKey: string; icon: React.ReactNode }> = {
  review: { labelKey: 'sessionWorkbenchUi.panels.review', icon: <FileDiff size={11} /> },
  screen: { labelKey: 'sessionWorkbenchUi.panels.screen', icon: <Monitor size={11} /> },
  browser: { labelKey: 'sessionWorkbenchUi.panels.browser', icon: <Globe size={11} /> },
};

/** 槽键 → { ownerId, panel }；ownerId 是 worker id 或主 agent id */
function slotKeyOf(agentId: string, workerId: string | undefined, panel: PanelKey): string {
  return `${workerId ?? agentId}|${workerId ? 'w' : 'm'}|${panel}`;
}

function parseSlotKey(key: string): { ownerId: string; isWorker: boolean; panel: PanelKey } {
  const [ownerId = '', kind = 'm', panel = 'review'] = key.split('|');
  return { ownerId, isWorker: kind === 'w', panel: panel as PanelKey };
}

export interface RightPanelProps {
  readonly agentId: string;
  /** 当前 agent tab 指向的 worker；undefined 即主会话 */
  readonly worker: WorkerVM | null;
  /** 当前可见的 tab（已扣掉被关掉的）；由模式层算，空数组时本组件不该被渲染 */
  readonly panels: readonly PanelKey[];
  /** 关掉一个 tab；关到空由模式层负责隐藏整栏 */
  readonly onClosePanel: (panel: PanelKey) => void;
  /**
   * 想看哪一页。**由模式层持有**，不是本组件的局部态 ——
   * 点流水里的文件条目要能把它推到 'review'，而那个入口在模式层
   * （见 `ThreadMode.openFileOp`）。放在本组件里就只能靠"强制覆盖选中页"去够，
   * 而强制覆盖会锁死手动切页——点别的 tab 没反应。
   */
  readonly wanted: PanelKey;
  readonly onPick: (panel: PanelKey) => void;
  /** 用户明确打开的文件操作或正文路径；只决定审阅内容，不锁死选中页。 */
  readonly reviewTarget?: FileReviewTarget;
  readonly topRailActions?: React.ReactNode;
}

export const RightPanel = memo<RightPanelProps>(
  ({
    agentId,
    worker,
    panels,
    onClosePanel,
    wanted,
    onPick,
    reviewTarget,
    topRailActions,
  }) => {
    const { t } = useTranslation();
    const selected = resolveSelectedPanel(wanted, panels);
    const currentKey = slotKeyOf(agentId, worker?.id, selected ?? 'review');
    const cache = useLruCache(CACHE_LIMIT, currentKey);

    /**
     * 切页**不清聚焦**。
     *
     * 审阅 tab 的存在条件就是 `reviewTarget`。切页时清目标，会把用户刚打开的审阅 tab
     * 一并移除。
     *
     * **目标与 tab 同生共死** —— 活到 tab 被关掉为止（`closePanel` 负责清）。
     * tab 记住自己在看什么本来就是预期行为；点另一条文件消息即切到那一次，
     * 本会话级的整体改动现阶段不提供（改动多在子流程，整体审阅另议）。
     */
    const pick = useCallback(
      (key: PanelKey) => {
        onPick(key);
        cache.touch(slotKeyOf(agentId, worker?.id, key));
      },
      [agentId, cache, onPick, worker?.id],
    );

    // 当前键必须在列表里（刚切 agent 时 touch 还没发生）
    const slots = useMemo(
      () =>
        cache.keys.includes(currentKey)
          ? cache.keys
          : [currentKey, ...cache.keys].slice(0, CACHE_LIMIT),
      [cache.keys, currentKey],
    );

    return (
      <div className={styles.panel}>
        <TopRail actions={topRailActions}>
          <div className={styles.tabs}>
            {panels.map((key) => (
              <span key={key} className={styles.tabSlot} data-selected={key === selected ? 'true' : undefined}>
                <button
                  type="button"
                  className={styles.tab}
                  onClick={() => pick(key)}
                >
                  {PANEL_META[key].icon}
                  {t(PANEL_META[key].labelKey)}
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  onClick={() => onClosePanel(key)}
                  aria-label={t('sessionWorkbenchUi.panels.closePanel', {
                    name: t(PANEL_META[key].labelKey),
                  })}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        </TopRail>

        <div className={styles.body}>
          {/* 浏览器页不进 LRU 缓存槽：页面状态活在主进程 WebContentsView，
              React 外壳卸载零成本 */}
          {selected === 'browser' ? (
            <div className={styles.slot}>
              <BrowserPanel />
            </div>
          ) : selected === 'review' ? (
            <div className={styles.slot}>
              <ReviewSlot
                agentId={agentId}
                workerId={worker?.id}
                target={reviewTarget}
              />
            </div>
          ) : (
          slots.map((key) => {
            const slot = parseSlotKey(key);
            return (
              <div key={key} className={styles.slot} data-hidden={key === currentKey ? undefined : 'true'}>
                <RightPanelSlot
                  agentId={slot.isWorker ? agentId : slot.ownerId}
                  workerId={slot.isWorker ? slot.ownerId : undefined}
                  panel={slot.panel}
                  hidden={key !== currentKey}
                />
              </div>
            );
          })
          )}
        </div>
      </div>
    );
  },
);

RightPanel.displayName = 'RightPanel';
