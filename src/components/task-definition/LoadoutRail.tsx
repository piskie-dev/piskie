/**
 * LoadoutRail —— 创建任务弹层右栏的「装备栏」+ 锚定配置浮层。
 *
 * 装备牌只做摘要(亮起 = 偏离默认,通电语言),永不展开、永不推挤;
 * 点牌后配置面板以 380px 浮层锚定在牌左侧、悬浮于简报区上方——
 * 浏览器环境是带状态点的多选清单(不选 = 临时浏览器),MCP 是
 * 「全部生效项 ⇄ 有序白名单」(序号即优先级,可上下移,清空 = 刻意禁用)。
 * 开关项(IM / 后台)直接在牌头拨;IM 开启即锁定审批为自动(锁在
 * task-draft reducer,这里只做视觉锁定)。
 *
 * 浮层动效是机械臂三段部署（样式见 taskDefinitionModal.module.css）：
 * 打开 = 充能 → 光梭射出 → 摊板显形 → 内容级联;收起为镜像三拍;
 * 换牌 = 折成光梭沿导轨滑行到新牌再弹开。编排全在本文件的三条时间线里,
 * 面板内的勾选/排序只刷内容,不重放动画。
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveBrowserEnvironmentPurpose } from '../../../shared/utils/browser-environment';
import { useBrowserEnvironmentStore } from '../../store/browserEnvironmentStore';
import { Toggle } from './controls';
import { nudgeMcp, type TaskDraft } from './task-draft';
import type { McpCatalog } from './useEffectiveMcp';
import styles from './taskDefinitionModal.module.css';

type TileKey = 'mode' | 'approval' | 'im' | 'env' | 'mcp' | 'ws' | 'bg';
type FlyKey = 'mode' | 'approval' | 'env' | 'mcp' | 'ws';
type FlyAnim = 'deploy' | 'retract' | 'arm' | 'unfold' | null;

/** 牌面摘要用末级目录名——全路径在浮层里完整多行展示 */
function workspaceName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** 双选面板的选项卡:标题 + 说明,选中通电(少选项时撑起信息量) */
const Choice: React.FC<{
  on: boolean;
  onPick: () => void;
  title: string;
  desc: string;
}> = ({ on, onPick, title, desc }) => (
  <button type="button" className={styles.choiceCard} data-on={on || undefined} onClick={onPick}>
    <span className={styles.choiceMain}>
      <span className={styles.choiceTitle}>{title}</span>
      <span className={styles.choiceDesc}>{desc}</span>
    </span>
    <span className={styles.check}>
      <Check size={13} />
    </span>
  </button>
);

export const LoadoutRail: React.FC<{
  draft: TaskDraft;
  patch: (next: Partial<TaskDraft>) => void;
  mcp: McpCatalog;
}> = ({ draft, patch, mcp }) => {
  const { t } = useTranslation();

  const environments = useBrowserEnvironmentStore((state) => state.environments);
  const environmentsLoading = useBrowserEnvironmentStore((state) => state.isLoading);
  const fetchEnvironments = useBrowserEnvironmentStore((state) => state.fetchEnvironments);
  useEffect(() => {
    void fetchEnvironments();
  }, [fetchEnvironments]);

  // ── 浮层状态机:shown = 当前内容;anim = 动效阶段;flash = 牌充能闪光 ──
  const [shown, setShown] = useState<FlyKey | null>(null);
  const [anim, setAnim] = useState<FlyAnim>(null);
  const [flashKey, setFlashKey] = useState<FlyKey | null>(null);

  const railRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<FlyKey | null>(null);
  const animRef = useRef<FlyAnim>(null);
  useEffect(() => {
    shownRef.current = shown;
    animRef.current = anim;
  }, [shown, anim]);

  const timers = useRef<number[]>([]);
  const after = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const openFly = useCallback(
    (key: FlyKey) => {
      setShown(key);
      setAnim('deploy');
      setFlashKey(key);
      after(560, () => setAnim((current) => (current === 'deploy' ? null : current)));
      after(500, () => setFlashKey((current) => (current === key ? null : current)));
    },
    [after],
  );

  const closeFly = useCallback(() => {
    if (!shownRef.current || animRef.current === 'retract') return;
    setAnim('retract');
    after(480, () => {
      setShown(null);
      setAnim((current) => (current === 'retract' ? null : current));
    });
  }, [after]);

  const switchFly = useCallback(
    (key: FlyKey) => {
      setAnim('arm');
      after(130, () => {
        setShown(key);
        setFlashKey(key);
      });
      after(370, () => setAnim((current) => (current === 'arm' ? 'unfold' : current)));
      after(630, () => setAnim((current) => (current === 'unfold' ? null : current)));
      after(700, () => setFlashKey((current) => (current === key ? null : current)));
    },
    [after],
  );

  const onTileHead = useCallback(
    (key: FlyKey) => {
      if (animRef.current === 'retract') return;
      if (shownRef.current === key) closeFly();
      else if (shownRef.current) switchFly(key);
      else openFly(key);
    },
    [closeFly, openFly, switchFly],
  );

  // 点浮层/装备栏之外的区域关浮层(事件在下方两个根节点上 stopPropagation)
  useEffect(() => {
    const onDocumentClick = (): void => closeFly();
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [closeFly]);

  // Esc:浮层开着时先关浮层(捕获期拦下,阻止原生 dialog 的 close request)
  useEffect(() => {
    if (!shown) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeFly();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [shown, closeFly]);

  // 定位:浮层顶对齐锚定牌(越界收敛),锚点光点对准牌头;行级联序号
  useLayoutEffect(() => {
    const fly = flyRef.current;
    const rail = railRef.current;
    const grid = rail?.parentElement;
    if (!fly || !rail || !grid || !shown) return;
    const tile = rail.querySelector(`[data-tile="${shown}"]`);
    if (!(tile instanceof HTMLElement)) return;
    const tileTop = tile.getBoundingClientRect().top - grid.getBoundingClientRect().top;
    const flyHeight = fly.offsetHeight;
    const top = Math.max(8, Math.min(tileTop, grid.clientHeight - flyHeight - 8));
    fly.style.top = `${top}px`;
    fly.style.setProperty(
      '--tie',
      `${Math.max(10, Math.min(tileTop - top + 14, flyHeight - 14))}px`,
    );
    const body = bodyRef.current;
    if (body) {
      [...body.children].forEach((child, index) =>
        (child as HTMLElement).style.setProperty('--i', String(index)),
      );
    }
  });

  // ── 草稿动作 ──
  const toggleEnv = (id: string): void =>
    patch({
      envIds: draft.envIds.includes(id)
        ? draft.envIds.filter((x) => x !== id)
        : [...draft.envIds, id],
    });

  const whitelist = draft.mcp === 'all' ? null : draft.mcp;
  const toggleMcpName = (name: string): void => {
    if (whitelist === null) return;
    patch({
      mcp: whitelist.includes(name)
        ? whitelist.filter((x) => x !== name)
        : [...whitelist, name],
    });
  };

  const pickWorkspace = async (): Promise<void> => {
    const paths = await window.piskie.desktop.files.select({ type: 'folder' });
    if (paths[0]) patch({ workspace: paths[0] });
  };

  // IM 开启时审批被 reducer 锁死,若审批浮层正开着则收起
  useEffect(() => {
    if (draft.im && shown === 'approval') closeFly();
  }, [draft.im, shown, closeFly]);

  // ── 牌面摘要与通电判定 ──
  const approvalAuto = (draft.im ? 'auto' : draft.approval) === 'auto';
  const envSummary = (() => {
    const firstId = draft.envIds[0];
    if (!firstId) return t('console.envTempBrowser');
    const first = environments.find((env) => env.id === firstId)?.name ?? firstId;
    return draft.envIds.length === 1
      ? first
      : t('console.envSummaryMore', { name: first, count: draft.envIds.length });
  })();
  const mcpSummary =
    whitelist === null
      ? t('console.mcpAllSummary')
      : whitelist.length === 0
        ? t('console.mcpDisabledSummary')
        : t('console.mcpWhitelistSummary', { count: whitelist.length });
  const background = draft.background ?? true;

  const tiles: ReadonlyArray<{
    key: TileKey;
    label: string;
    value: string;
    lit: boolean;
    locked?: boolean;
    /** 有值 = 纯开关牌:整张牌头即开关(role=switch),牌内开关件为纯视觉 */
    switchOn?: boolean;
    onFlip?: (on: boolean) => void;
  }> = [
    {
      key: 'mode',
      label: t('console.modeId'),
      value: draft.mode === 'plan' ? t('console.modeReviewFirst') : t('console.modeRunNow'),
      lit: draft.mode !== 'normal',
    },
    {
      key: 'approval',
      label: t('console.approvalMode'),
      value: approvalAuto ? t('console.approvalAutoShort') : t('console.approvalConfirmShort'),
      lit: approvalAuto,
      locked: draft.im,
    },
    {
      key: 'im',
      label: t('console.imIntake'),
      value: draft.im ? t('console.switchOn') : t('console.switchOff'),
      lit: draft.im,
      switchOn: draft.im,
      onFlip: (on) => patch({ im: on }),
    },
    {
      key: 'env',
      label: t('console.browserEnvBinding'),
      value: envSummary,
      lit: draft.envIds.length > 0,
    },
    {
      key: 'mcp',
      label: t('console.mcpConnections'),
      value: mcpSummary,
      lit: whitelist !== null,
    },
    {
      key: 'ws',
      label: t('console.workspace'),
      value: workspaceName(draft.workspace) ?? t('console.workspaceDefault'),
      lit: !!draft.workspace,
    },
    {
      key: 'bg',
      label: t('console.browserBackground'),
      value: background ? t('console.switchOn') : t('console.switchOff'),
      lit: !background,
      switchOn: background,
      onFlip: (on) => patch({ background: on }),
    },
  ];

  const flyLit: Record<FlyKey, boolean> = {
    mode: draft.mode !== 'normal',
    approval: approvalAuto,
    env: draft.envIds.length > 0,
    mcp: whitelist !== null,
    ws: !!draft.workspace,
  };
  const flyLabel: Record<FlyKey, string> = {
    mode: t('console.modeId'),
    approval: t('console.approvalMode'),
    env: t('console.browserEnvBinding'),
    mcp: t('console.mcpConnections'),
    ws: t('console.workspace'),
  };

  const panelFor = (key: FlyKey): React.ReactNode => {
    if (key === 'mode') {
      return (
        <>
          <Choice
            on={draft.mode === 'normal'}
            title={t('console.modeRunNow')}
            desc={t('console.modeNormalDesc')}
            onPick={() => {
              patch({ mode: 'normal' });
              closeFly();
            }}
          />
          <Choice
            on={draft.mode === 'plan'}
            title={t('console.modeReviewFirst')}
            desc={t('console.modePlanDesc')}
            onPick={() => {
              patch({ mode: 'plan' });
              closeFly();
            }}
          />
        </>
      );
    }
    if (key === 'approval') {
      return (
        <>
          <Choice
            on={!approvalAuto}
            title={t('console.approvalConfirmShort')}
            desc={t('console.approvalConfirmDesc')}
            onPick={() => {
              patch({ approval: 'confirm' });
              closeFly();
            }}
          />
          <Choice
            on={approvalAuto}
            title={t('console.approvalAutoShort')}
            desc={t('console.approvalAutoDesc')}
            onPick={() => {
              patch({ approval: 'auto' });
              closeFly();
            }}
          />
        </>
      );
    }
    if (key === 'env') {
      return (
        <>
          <p className={styles.noteText}>{t('console.browserEnvHint')}</p>
          {environments.length === 0 && (
            <p className={styles.noteText}>
              {environmentsLoading ? t('console.envLoading') : t('console.envEmpty')}
            </p>
          )}
          {environments.map((env) => {
            const purpose = resolveBrowserEnvironmentPurpose(env);
            return (
              <button
                key={env.id}
                type="button"
                className={styles.envRow}
                data-on={draft.envIds.includes(env.id) || undefined}
                onClick={() => toggleEnv(env.id)}
              >
                <span
                  className={styles.statusDot}
                  data-busy={env.status === 'running' || undefined}
                />
                <span className={styles.envMain}>
                  <span className={styles.envTop}>
                    <span className={styles.envName}>{env.name}</span>
                    <span className={styles.envState}>
                      {env.status === 'running' ? t('console.envBusy') : t('console.envIdle')}
                    </span>
                  </span>
                  {purpose && <span className={styles.envPurpose}>{purpose}</span>}
                </span>
                <span className={styles.check}>
                  <Check size={12} />
                </span>
              </button>
            );
          })}
        </>
      );
    }
    if (key === 'mcp') {
      return (
        <>
          <div className={styles.mcpHead}>
            <span>
              <span className={styles.mcpHeadTitle}>{t('console.mcpUseAll')}</span>
              <p className={styles.mcpHeadDesc}>
                {whitelist === null
                  ? t('console.mcpAllNote', { count: mcp.picks.length })
                  : t('console.mcpSelectionOrder')}
              </p>
            </span>
            <Toggle
              on={whitelist === null}
              disabled={mcp.loading && mcp.picks.length === 0}
              ariaLabel={t('console.mcpUseAll')}
              onFlip={(useAll) =>
                // 从「全部」切到白名单时预填全部生效项,避免一上来就是空上界
                patch({ mcp: useAll ? 'all' : mcp.picks.map((pick) => pick.value) })
              }
            />
          </div>
          {whitelist !== null && (
            <>
              <div className={styles.hr} />
              {whitelist.map((name, index) => {
                const pick = mcp.picks.find((candidate) => candidate.value === name);
                return (
                  <div key={name} className={styles.mcpRow}>
                    <span className={styles.order}>{index + 1}</span>
                    <button
                      type="button"
                      className={styles.mcpHit}
                      onClick={() => toggleMcpName(name)}
                    >
                      <span className={styles.mcpName}>{name}</span>
                      {pick ? (
                        <span className={styles.mcpSrc}>{pick.origin}</span>
                      ) : (
                        <span className={styles.mcpMissing}>{t('console.mcpUnavailable')}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={styles.move}
                      disabled={index === 0}
                      aria-label={`${t('console.mcpMoveUp')} ${name}`}
                      onClick={() => patch({ mcp: nudgeMcp(whitelist, index, -1) })}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      className={styles.move}
                      disabled={index === whitelist.length - 1}
                      aria-label={`${t('console.mcpMoveDown')} ${name}`}
                      onClick={() => patch({ mcp: nudgeMcp(whitelist, index, 1) })}
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                );
              })}
              {mcp.picks
                .filter((pick) => !whitelist.includes(pick.value))
                .map((pick) => (
                  <div key={pick.value} className={styles.mcpRow} data-off="true">
                    <span className={styles.order} />
                    <button
                      type="button"
                      className={styles.mcpHit}
                      onClick={() => toggleMcpName(pick.value)}
                    >
                      <span className={styles.mcpName}>{pick.value}</span>
                      <span className={styles.mcpSrc}>{pick.origin}</span>
                    </button>
                  </div>
                ))}
              {whitelist.length === 0 && (
                <p className={styles.noteText} data-tone="waiting">
                  {t('console.mcpNoneSelected')}
                </p>
              )}
            </>
          )}
          {mcp.failure && (
            <p className={styles.noteText} data-tone="waiting">
              {mcp.failure}
            </p>
          )}
        </>
      );
    }
    return (
      <>
        <span className={styles.wsPath} data-set={!!draft.workspace || undefined}>
          {draft.workspace || t('console.workspaceDefault')}
        </span>
        <div className={styles.wsRow}>
          <button type="button" className={styles.wsBtn} onClick={() => void pickWorkspace()}>
            {t('console.selectFolder')}
          </button>
          {draft.workspace && (
            <button
              type="button"
              className={styles.wsBtn}
              onClick={() => patch({ workspace: undefined })}
            >
              {t('console.clearFolder')}
            </button>
          )}
        </div>
        <p className={styles.noteText}>{t('console.workspaceBoundaryHint')}</p>
      </>
    );
  };

  const flyClassName = [
    styles.fly,
    anim === 'deploy' && styles.deploy,
    anim === 'retract' && styles.retract,
    anim === 'arm' && `${styles.arming} ${styles.asArm}`,
    anim === 'unfold' && `${styles.unfolding} ${styles.pop}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div
        ref={railRef}
        className={styles.rail}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.railTag}>{t('console.loadoutEyebrow')}</div>
        {tiles.map((tile) => (
          <React.Fragment key={tile.key}>
            <div
              className={styles.tile}
              data-tile={tile.key}
              data-lit={tile.lit || undefined}
              data-locked={tile.locked || undefined}
              data-open={shown === tile.key || undefined}
              data-flash={flashKey === tile.key || undefined}
            >
              {tile.onFlip ? (
                <button
                  type="button"
                  className={styles.tileHead}
                  role="switch"
                  aria-checked={tile.switchOn}
                  onClick={() => tile.onFlip?.(!tile.switchOn)}
                >
                  <span className={styles.tileKey}>
                    {tile.label}
                    <span
                      className={styles.toggle}
                      data-on={tile.switchOn || undefined}
                      aria-hidden
                    />
                  </span>
                  <span className={styles.tileValue}>{tile.value}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.tileHead}
                  disabled={tile.locked}
                  aria-expanded={shown === tile.key}
                  onClick={() => onTileHead(tile.key as FlyKey)}
                >
                  <span className={styles.tileKey}>
                    {tile.label}
                    <span className={styles.dot} />
                  </span>
                  <span className={styles.tileValue}>{tile.value}</span>
                </button>
              )}
            </div>
            {tile.key === 'im' && draft.im && (
              <p className={styles.railNote}>{t('console.imIntakeHint')}</p>
            )}
          </React.Fragment>
        ))}
      </div>

      {shown && (
        <div
          ref={flyRef}
          className={flyClassName}
          data-lit={flyLit[shown] || undefined}
          role="dialog"
          aria-label={flyLabel[shown]}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.flyBeam} />
          <div ref={bodyRef} className={styles.flyBody}>
            {panelFor(shown)}
          </div>
        </div>
      )}
    </>
  );
};
