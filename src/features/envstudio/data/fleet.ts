/**
 * EnvStudio 数据层 · 环境舰队
 *
 * 环境清单只由 browserEnvironmentStore 持有；本层编排页面动作与辅助读数。
 * 占用事实来自共享的 occupancyStore（跨模块状态源，不重写）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserEnvironment } from '@shared/types';
import type { ProxyProfile } from '@shared/types/proxy';
import type { Occupancy } from '@shared/types/occupancy';
import { useBrowserEnvironmentStore } from '../../../store/browserEnvironmentStore';
import { useOccupancyStore } from '../../../store/occupancyStore';
import {
  messageText,
  rawText,
  type PresentationText,
} from '../../../i18n/presentationText';

interface KernelReadout {
  installed: boolean;
  version: string;
  busyPhase?: 'download' | 'verify' | 'extract' | 'done' | 'error';
  busyMessage?: string;
}

export interface FleetSnapshot {
  envs: BrowserEnvironment[];
  proxies: ProxyProfile[];
  kernel: KernelReadout | null;
  loading: boolean;
  fault: PresentationText | null;
}

export interface FleetActions {
  reload(): Promise<void>;
  ignite(envId: string): Promise<BrowserEnvironment | null>;
  extinguish(envId: string): Promise<BrowserEnvironment | null>;
  surface(envId: string): Promise<boolean>;
  scrap(envId: string): Promise<boolean>;
}

// 占用查询与字段格式器与会话输入框的浏览器控件共用，定义在 utils。
export { identityLineOf, occupantOf, proxyLabelOf } from '../../../utils/browserEnvironmentPresentation';

export function useFleet(): FleetSnapshot & FleetActions {
  const [proxies, setProxies] = useState<ProxyProfile[]>([]);
  const [kernel, setKernel] = useState<KernelReadout | null>(null);
  const [loading, setLoading] = useState(true);
  const [fault, setFault] = useState<PresentationText | null>(null);
  const alive = useRef(true);

  const envs = useBrowserEnvironmentStore((store) => store.environments);
  const environmentsLoading = useBrowserEnvironmentStore((store) => store.isLoading);
  const environmentFault = useBrowserEnvironmentStore((store) => store.error);
  const fetchEnvironments = useBrowserEnvironmentStore((store) => store.fetchEnvironments);
  const pullOccupancies = useOccupancyStore((store) => store.fetchOccupancies);

  const reload = useCallback(async () => {
    try {
      const [, proxyConfig, kernelStatus] = await Promise.all([
        fetchEnvironments(),
        window.piskie.configuration.proxy.read(),
        window.piskie.pilot.environments.kernelStatus(),
      ]);
      if (!alive.current) return;
      setProxies(proxyConfig?.proxies ?? []);
      setKernel({
        installed: kernelStatus.installed,
        version: kernelStatus.version,
        busyPhase: kernelStatus.progress?.phase,
        busyMessage: kernelStatus.progress?.message,
      });
      setFault(null);
    } catch (error) {
      if (!alive.current) return;
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.studio.loadFailed'));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [fetchEnvironments]);

  useEffect(() => {
    alive.current = true;
    const timer = window.setTimeout(() => {
      void reload();
      void pullOccupancies();
    }, 0);
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
    };
  }, [reload, pullOccupancies]);

  const ignite = useCallback(async (envId: string) => {
    try {
      const next = await window.piskie.pilot.environments.start(envId);
      await fetchEnvironments();
      return next;
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.studio.startFailed'));
      return null;
    }
  }, [fetchEnvironments]);

  const extinguish = useCallback(async (envId: string) => {
    try {
      const next = await window.piskie.pilot.environments.stop(envId);
      await fetchEnvironments();
      return next;
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.studio.stopFailed'));
      return null;
    }
  }, [fetchEnvironments]);

  const surface = useCallback(async (envId: string) => {
    try {
      return await window.piskie.pilot.environments.showWindow(envId);
    } catch {
      return false;
    }
  }, []);

  const scrap = useCallback(async (envId: string) => {
    try {
      await window.piskie.pilot.environments.delete(envId);
      await fetchEnvironments();
      return true;
    } catch (error) {
      setFault(error instanceof Error
        ? rawText(error.message)
        : messageText('environmentUi.studio.deleteFailed'));
      return false;
    }
  }, [fetchEnvironments]);

  return useMemo(
    () => ({
      envs,
      proxies,
      kernel,
      loading: loading || environmentsLoading,
      fault: environmentFault ? rawText(environmentFault) : fault,
      reload,
      ignite,
      extinguish,
      surface,
      scrap,
    }),
    [
      envs,
      proxies,
      kernel,
      loading,
      environmentsLoading,
      environmentFault,
      fault,
      reload,
      ignite,
      extinguish,
      surface,
      scrap,
    ],
  );
}

/** 供视图判断占用（导出共享 store 的选择器，避免视图直接 import store） */
export function useOccupancies(): Occupancy[] {
  return useOccupancyStore((state) => state.occupancies);
}
