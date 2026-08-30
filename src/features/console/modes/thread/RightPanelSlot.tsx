/**
 * RightPanelSlot —— 右栏的一个缓存槽。
 *
 * 每个槽是**独立组件实例**，自己订阅自己那个 agent 的 VM。这样才能实现规格要的
 * 「**面板间与 worker 间**都用 `content-visibility: hidden` 缓存」——
 * 若由 `RightPanel` 统一取数，它只有当前 worker 的 VM，隐藏槽就只能渲染空壳，
 * 缓存等于只在同一 agent 的面板间生效（切 worker 仍重建）。
 *
 * 槽是组件 ⇒ 可以在自己内部调 `useWorkerVM`（hooks 不能在循环里调，但每个槽是一次挂载）。
 *
 * `fidelity` 双面执行：CSS 那半在父级的 `content-visibility`，
 * 订阅那半在这里——隐藏槽传 `hidden`，流暂停。
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { BrowserScreenView } from '../../content/ScreenView';
import { useWorkerVM } from '../../data/vm';
import type { PanelKey } from './panels';
import styles from './rightPanel.module.css';

export interface RightPanelSlotProps {
  /** 主 agent id（worker 槽的父） */
  readonly agentId: string;
  /** 有值即该 worker 的槽；无值即主会话的槽 */
  readonly workerId?: string;
  readonly panel: PanelKey;
  readonly hidden: boolean;
}

export const RightPanelSlot = memo<RightPanelSlotProps>(
  ({ agentId, workerId, panel, hidden }) => {
    const { t } = useTranslation();
    const worker = useWorkerVM(workerId ? agentId : undefined, workerId);
    const fidelity = hidden ? 'hidden' : 'visible';

    if (panel === 'screen') {
      if (worker?.browserId) {
        return (
          <BrowserScreenView
            subagentId={worker.id}
            browserId={worker.browserId}
            browserReady={worker.browserReady}
            title={worker.subject}
            fidelity={fidelity}
            // thread 右栏可直接上手操作被控浏览器；dock 维持只读投屏
            interactive
          />
        );
      }
      return <div className={styles.empty}>{t('sessionWorkbenchUi.screen.noAgentScreen')}</div>;
    }

    // 'review' 由 RightPanel 直渲（不进缓存槽），不会到这里
    return null;
  },
);

RightPanelSlot.displayName = 'RightPanelSlot';
