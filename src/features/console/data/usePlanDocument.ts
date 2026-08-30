/**
 * 计划正文按需读取（审批对象 = 计划正文）。
 *
 * IPC 归数据层，组件不直接发；"没有获批的计划"不是 toast，而是弹窗里的空态
 * ——用户点了「查看计划」，就该看到一个回答，而不是一个飘走的提示。
 */

import { useCallback, useState } from 'react';

export interface PlanDocument {
  readonly taskSummary: string;
  readonly content: string;
}

export interface PlanDocumentState {
  readonly open: boolean;
  readonly document: PlanDocument | null;
  readonly loading: boolean;
  readonly view: () => void;
  readonly close: () => void;
}

export function usePlanDocument(agentId?: string): PlanDocumentState {
  const [open, setOpen] = useState(false);
  const [document, setDocument] = useState<PlanDocument | null>(null);
  const [loading, setLoading] = useState(false);

  const view = useCallback(() => {
    setOpen(true);
    if (!agentId) {
      setDocument(null);
      return;
    }

    setLoading(true);
    void (async () => {
      try {
        const result = await window.piskie.agentRuns.readPlan(agentId);
        setDocument({ taskSummary: result.taskSummary, content: result.content });
      } catch {
        setDocument(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [agentId]);

  const close = useCallback(() => setOpen(false), []);

  return { open, document, loading, view, close };
}
