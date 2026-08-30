/**
 * 浏览器环境绑定选择器(装备栏 slot 形态;2026-08-25 去 antd 重写)。
 *
 * 原 antd Dropdown/Popover/Tag/Tooltip 全部换为 PopShell + 自绘皮肤
 * (bindingPicker.module.css,观感对齐原深浅主题);原 `variant="form"` 的
 * antd Select 分支无消费者,一并删除。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chrome, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useBrowserEnvironmentStore } from '../store/browserEnvironmentStore';
import { resolveBrowserEnvironmentPurpose } from '../../shared/utils/browser-environment';
import type { BrowserEnvironment } from '../../shared/types';
import { PopShell } from './shared/PopShell';
import styles from './bindingPicker.module.css';

interface BrowserEnvironmentBindingPickerProps {
  value: string[];
  onChange: (environmentIds: string[]) => void;
  className?: string;
  compact?: boolean;
}

type TagTone = 'blue' | 'orange' | 'default';

function getEnvironmentStatusMeta(
  environment: BrowserEnvironment | undefined,
  translate: (key: string) => string,
): { label: string; dotClass: string; tone: TagTone } {
  if (!environment) {
    return { label: translate('sharedUi.browserBinding.missing'), dotClass: 'bg-red-400', tone: 'default' };
  }
  if (environment.status === 'running') {
    return { label: translate('sharedUi.browserBinding.running'), dotClass: 'bg-amber-400', tone: 'orange' };
  }
  return { label: translate('sharedUi.browserBinding.idle'), dotClass: 'bg-emerald-400', tone: 'blue' };
}

/** 环境标签 + 悬停说明(原 Tag+Tooltip) */
const EnvironmentTag: React.FC<{
  readonly tone: TagTone;
  readonly name: string;
  readonly tip: string;
  readonly onRemove?: () => void;
  readonly removeLabel?: string;
}> = ({ tone, name, tip, onRemove, removeLabel }) => {
  const [tipOpen, setTipOpen] = useState(false);
  return (
    <PopShell
      open={tipOpen}
      onClose={() => setTipOpen(false)}
      placement="block-start"
      trigger={(
        <span
          className={styles.tag}
          data-tone={tone}
          onMouseEnter={() => setTipOpen(true)}
          onMouseLeave={() => setTipOpen(false)}
        >
          <span className="text-xs">{name}</span>
          {onRemove && (
            <button
              type="button"
              className={styles.tagClose}
              onClick={onRemove}
              aria-label={removeLabel}
            >
              <X size={10} />
            </button>
          )}
        </span>
      )}
    >
      <div className={styles.tip}>{tip}</div>
    </PopShell>
  );
};

const BrowserEnvironmentBindingPicker: React.FC<BrowserEnvironmentBindingPickerProps> = ({
  value,
  onChange,
  className = '',
  compact = false,
}) => {
  const { t } = useTranslation();
  const environments = useBrowserEnvironmentStore((state) => state.environments);
  const isLoading = useBrowserEnvironmentStore((state) => state.isLoading);
  const fetchEnvironments = useBrowserEnvironmentStore((state) => state.fetchEnvironments);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  /* light-dismiss 先于 click:pointerdown 快照,click 按快照定开关 */
  const menuWasOpen = useRef(false);
  const stackWasOpen = useRef(false);

  useEffect(() => {
    void fetchEnvironments();
  }, [fetchEnvironments]);

  const selectedIds = useMemo(
    () => value.filter((id, index) => !!id && value.indexOf(id) === index),
    [value],
  );
  const selectedEnvironments = useMemo(
    () => selectedIds.map((id) => ({
      id,
      environment: environments.find((candidate) => candidate.id === id),
    })),
    [environments, selectedIds],
  );
  const availableEnvironments = useMemo(
    () => environments.filter((environment) => !selectedIds.includes(environment.id)),
    [environments, selectedIds],
  );

  const addEnvironment = useCallback(
    (environmentId: string) => {
      if (!environmentId || selectedIds.includes(environmentId)) return;
      onChange([...selectedIds, environmentId]);
    },
    [onChange, selectedIds],
  );
  const removeEnvironment = useCallback(
    (environmentId: string) => {
      onChange(selectedIds.filter((id) => id !== environmentId));
    },
    [onChange, selectedIds],
  );

  /* 追加菜单(原 antd Dropdown) */
  const addMenu = (
    <div className={styles.menu} role="menu">
      {availableEnvironments.length > 0 ? availableEnvironments.map((environment) => {
        const status = getEnvironmentStatusMeta(environment, t);
        return (
          <button
            key={environment.id}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              addEnvironment(environment.id);
              setMenuOpen(false);
            }}
          >
            <div className="flex min-w-[260px] items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <Chrome size={14} className="shrink-0 text-sky-300" />
                <span className="min-w-0 truncate text-sm">{environment.name}</span>
                <span className="max-w-[150px] shrink truncate text-[11px] text-zinc-500">
                  {resolveBrowserEnvironmentPurpose(environment)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-400">
                <span className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} />
                {status.label}
              </span>
            </div>
          </button>
        );
      }) : (
        <button type="button" className={styles.menuItem} disabled>
          {isLoading
            ? t('sharedUi.browserBinding.loading')
            : t('sharedUi.browserBinding.empty')}
        </button>
      )}
    </div>
  );

  const addTrigger = (label: string) => (
    <button
      type="button"
      onPointerDown={() => { menuWasOpen.current = menuOpen; }}
      onClick={() => setMenuOpen(!menuWasOpen.current)}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700/50"
    >
      <Plus size={11} />
      <span>{label}</span>
    </button>
  );

  if (compact && selectedEnvironments.length >= 2) {
    return (
      <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
        <PopShell
          open={stackOpen}
          onClose={() => setStackOpen(false)}
          placement="block-start"
          trigger={(
            <button
              type="button"
              onPointerDown={() => { stackWasOpen.current = stackOpen; }}
              onClick={() => setStackOpen(!stackWasOpen.current)}
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs text-gray-400 transition-colors hover:text-gray-200"
              aria-label={t('sharedUi.browserBinding.selectedCount', { count: selectedIds.length })}
            >
              <Chrome size={14} className="shrink-0" />
              <span>{t('sharedUi.browserBinding.compactCount', { count: selectedIds.length })}</span>
            </button>
          )}
        >
          <div className={styles.stack}>
            {selectedEnvironments.map(({ id, environment }) => {
              const status = getEnvironmentStatusMeta(environment, t);
              return (
                <div key={id} className="flex items-center justify-between gap-2">
                  <EnvironmentTag
                    tone={status.tone}
                    name={environment?.name ?? id}
                    tip={`${id} · ${resolveBrowserEnvironmentPurpose(environment ?? {})}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvironment(id)}
                    className="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:text-red-400"
                    aria-label={t('sharedUi.browserBinding.removeNamed', { name: environment?.name ?? id })}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </PopShell>
        <PopShell
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          placement="block-start"
          trigger={addTrigger(t('sharedUi.browserBinding.add'))}
        >
          {addMenu}
        </PopShell>
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <Chrome size={14} className="shrink-0 text-gray-400" />
      {selectedEnvironments.map(({ id, environment }) => {
        const status = getEnvironmentStatusMeta(environment, t);
        return (
          <EnvironmentTag
            key={id}
            tone={status.tone}
            name={environment?.name ?? id}
            tip={`${id} · ${resolveBrowserEnvironmentPurpose(environment ?? {})}`}
            onRemove={() => removeEnvironment(id)}
            removeLabel={t('sharedUi.browserBinding.removeNamed', { name: environment?.name ?? id })}
          />
        );
      })}
      <PopShell
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        placement="block-start"
        trigger={addTrigger(selectedIds.length === 0
          ? t('sharedUi.browserBinding.choose')
          : t('sharedUi.browserBinding.add'))}
      >
        {addMenu}
      </PopShell>
    </div>
  );
};

export default BrowserEnvironmentBindingPicker;
