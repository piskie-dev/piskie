/**
 * useEffectiveMcp —— 拉取「当前工作空间下生效且启用的 MCP 项」清单。
 *
 * 数据源是能力市场预览（`capabilities.market.preview`），跟随所选工作空间刷新。
 * 返回单对象状态，避免 loading / 数据 / 错误三者的中间态互相打架。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface McpPick {
  readonly value: string;
  /** 来源描述（全局 / 项目 / 插件: xxx），装备栏白名单行内展示 */
  readonly origin: string;
}

export interface McpCatalog {
  readonly picks: readonly McpPick[];
  readonly loading: boolean;
  readonly failure: string | null;
}

const IDLE: McpCatalog = { picks: [], loading: false, failure: null };

export function useEffectiveMcp(open: boolean, workspace: string | undefined): McpCatalog {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<McpCatalog>(IDLE);

  useEffect(() => {
    if (!open) return;
    let alive = true;

    // 微任务里进 loading 态，满足 set-state-in-effect 约束
    queueMicrotask(() => {
      if (alive) setCatalog((current) => ({ ...current, loading: true, failure: null }));
    });

    void window.piskie.capabilities.market
      .preview(workspace)
      .then((response) => {
        if (!alive) return;
        const dedup = new Map<string, McpPick>();
        for (const item of response.items) {
          if (item.kind !== 'mcp' || !item.effective || !item.enabled) continue;
          const origin = item.plugin
            ? `${t('console.mcpSourcePlugin')}: ${item.plugin}`
            : item.scope === 'project'
              ? t('console.mcpSourceProject')
              : t('console.mcpSourceGlobal');
          dedup.set(item.name, { value: item.name, origin });
        }
        const picks = [...dedup.values()].sort((a, b) => a.value.localeCompare(b.value));
        setCatalog({ picks, loading: false, failure: null });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setCatalog({
          picks: [],
          loading: false,
          failure: error instanceof Error ? error.message : t('console.mcpLoadFailed'),
        });
      });

    return () => {
      alive = false;
    };
  }, [open, t, workspace]);

  return catalog;
}
