/**
 * 全局参数页（按网关分设）。
 *
 * image:单次图片生成超时(秒↔ms,只终止当前请求不切换模型);
 * ai:流空闲超时(1-600s)+ 最大重试(0-9,存储为 maxAttempts-1)
 *     + 可用模型目录表(搜索/Provider/能力/生命周期/前端分页)。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';

import type { InferenceModelDefinition } from '../../../../shared/types/inference';
import { useInferenceStore, type InferenceGatewayKind } from '../../../store/inferenceStore';
import styles from '../deck.module.css';

const PAGE_SIZE = 12;

export const TuningDesk: React.FC<{ readonly gateway: InferenceGatewayKind }> = ({ gateway }) => (
  gateway === 'image' ? <ImageTuning /> : <AiTuning />
);

/** 数字策略输入:失焦/回车提交,非法回落当前值 */
function PolicyNumber({
  value,
  min,
  max,
  ariaLabel,
  onCommit,
}: {
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly ariaLabel: string;
  readonly onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const parsed = Number.parseInt(draft, 10);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(min, max !== undefined ? Math.min(max, parsed) : parsed);
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <span className={styles.textIn} style={{ maxInlineSize: 200 }}>
      <input
        className={styles.monoIn}
        type="number"
        min={min}
        max={max}
        value={draft ?? String(value)}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </span>
  );
}

function ImageTuning() {
  const { t } = useTranslation();
  const config = useInferenceStore((s) => s.config);
  const updatePolicies = useInferenceStore((s) => s.updatePolicies);
  if (!config) return null;
  const policy = config.policies.image;

  return (
    <div className={styles.deskBody}>
      <div className={styles.slab}>
        <div className={styles.slabCap}>{t('settings.tuning.imageDefaults')}</div>
        <label className={styles.fieldTag}>{t('settings.tuning.imageTimeoutSeconds')}</label>
        <PolicyNumber
          value={Math.round(policy.operationTimeoutMs / 1_000)}
          min={1}
          ariaLabel={t('settings.tuning.imageTimeoutAria')}
          onCommit={(seconds) => void updatePolicies('image', { operationTimeoutMs: seconds * 1_000 })}
        />
        <div className={styles.fieldNote}>{t('settings.tuning.imageTimeoutHint')}</div>
      </div>
    </div>
  );
}

function AiTuning() {
  const { t } = useTranslation();
  const config = useInferenceStore((s) => s.config);
  const models = useInferenceStore((s) => s.models.ai);
  const updatePolicies = useInferenceStore((s) => s.updatePolicies);
  const [needle, setNeedle] = useState('');
  const [page, setPage] = useState(1);

  if (!config) return null;
  const policy = config.policies.ai;

  const keyword = needle.trim().toLocaleLowerCase();
  const filtered = keyword
    ? models.filter((model) => (
      `${model.id} ${model.displayName} ${model.family ?? ''}`.toLocaleLowerCase().includes(keyword)
    ))
    : models;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className={styles.deskBody}>
      <div className={styles.slab}>
        <div className={styles.slabCap}>{t('settings.tuning.aiDefaults')}</div>
        <div className={styles.duoGrid}>
          <div>
            <label className={styles.fieldTag}>{t('settings.tuning.streamIdleSeconds')}</label>
            <PolicyNumber
              value={Math.round(policy.streamIdleTimeoutMs / 1_000)}
              min={1}
              max={600}
              ariaLabel={t('settings.tuning.streamIdleAria')}
              onCommit={(seconds) => void updatePolicies('ai', { streamIdleTimeoutMs: seconds * 1_000 })}
            />
            <div className={styles.fieldNote}>{t('settings.tuning.streamIdleHint')}</div>
          </div>
          <div>
            <label className={styles.fieldTag}>{t('settings.tuning.maxRetries')}</label>
            <PolicyNumber
              value={Math.max(0, policy.maxAttempts - 1)}
              min={0}
              max={9}
              ariaLabel={t('settings.tuning.maxRetries')}
              onCommit={(retries) => void updatePolicies('ai', { maxAttempts: retries + 1 })}
            />
            <div className={styles.fieldNote}>{t('settings.tuning.maxRetriesHint')}</div>
          </div>
        </div>
      </div>

      <div className={styles.slab}>
        <div className={styles.slabCap}>
          {t('settings.tuning.availableModels', { count: filtered.length })}
          <span className={styles.capSpring} />
          <span className={styles.textIn} style={{ maxInlineSize: 240, minBlockSize: 27 }}>
            <Search size={12} />
            <input
              value={needle}
              placeholder={t('settings.tuning.searchPlaceholder')}
              aria-label={t('settings.tuning.searchAria')}
              onChange={(event) => {
                setNeedle(event.target.value);
                setPage(1);
              }}
            />
          </span>
        </div>

        {visible.map((model) => (
          <div key={model.id} className={styles.rowLine} data-hover="true" style={{ minBlockSize: 40 }}>
            <span className={styles.rowMain}>
              <span className={styles.rowName}>
                <span className={styles.monoNote} style={{ fontSize: 12.5 }}>{model.id}</span>
              </span>
              <span className={styles.rowNote}>{model.family ?? t('settings.tuning.customFamily')} · {model.displayName}</span>
            </span>
            <TableCap label={t('settings.tuning.tools')} value={model.capabilities.tools} />
            <TableCap label={t('settings.tuning.vision')} value={model.capabilities.vision} />
            <TableCap label={t('settings.tuning.streaming')} value={model.capabilities.streaming} />
            <TableCap label={t('settings.tuning.reasoning')} value={model.capabilities.reasoning} />
            <LifecycleWord lifecycle={model.lifecycle} />
          </div>
        ))}
        {visible.length === 0 && <div className={styles.voidBox}>{t('settings.tuning.noMatches')}</div>}

        {pageCount > 1 && (
          <div className={styles.pageRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet}`}
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              {t('settings.tuning.previous')}
            </button>
            <span>{safePage} / {pageCount}</span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet}`}
              disabled={safePage >= pageCount}
              onClick={() => setPage(safePage + 1)}
            >
              {t('settings.tuning.next')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TableCap({ label, value }: { readonly label: string; readonly value: boolean | undefined }) {
  return (
    <span className={styles.chip} data-state={value === undefined ? 'warn' : value ? 'yes' : 'no'}>
      {label}
      {value === undefined ? ' ?' : value ? '' : ' ×'}
    </span>
  );
}

function LifecycleWord({ lifecycle }: { readonly lifecycle: InferenceModelDefinition['lifecycle'] }) {
  const { t } = useTranslation();
  const word = {
    preview: t('settings.tuning.lifecyclePreview'),
    active: t('settings.tuning.lifecycleActive'),
    deprecated: t('settings.tuning.lifecycleDeprecated'),
    retired: t('settings.tuning.lifecycleRetired'),
  }[lifecycle];
  return (
    <span
      className={styles.chip}
      data-state={lifecycle === 'deprecated' || lifecycle === 'retired' ? 'warn' : undefined}
    >
      {word}
    </span>
  );
}
