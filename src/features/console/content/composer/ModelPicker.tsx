/**
 * ModelPicker —— 会话输入器中的模型 + 思考程度选择器。
 *
 * 展示当前会话保存的思考值，模型目录提供模型与可选档位。
 * 支持搜索 / 按 Provider 分组 / budget tokens / mandatory 锁提示，
 * 外壳用 `chrome/Popover`（原生 popover，top layer + light-dismiss）。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, LockKeyhole, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { InferenceModelDefinition } from '../../../../../shared/types/inference';
import type { ReasoningSelection } from '../../../../../shared/types/reasoning';
import type { ModelOptGroup } from '../../../../store/inferenceStore';
import {
  getSelectableReasoningOptions,
  reasoningOptionKey,
  reasoningSelectionLabel,
} from '../../../../utils/reasoning-options';
import { isReasoningInputValid } from '../../../../utils/reasoning-capabilities';
import { Popover } from '../../chrome/Popover';
import styles from './conversationComposer.module.css';

export interface ModelPickerProps {
  readonly modelGroups: ModelOptGroup[];
  readonly model: string;
  /** 目标运行时实际保存的思考值；主 Agent 与 Worker 一致，选择器只展示、不自动写回。 */
  readonly reasoningOverride: ReasoningSelection;
  readonly onModelChange: (next: string) => Promise<void>;
  readonly onReasoningChange: (selection?: ReasoningSelection) => Promise<void>;
  readonly disabled?: boolean;
}

interface FlatModel {
  readonly value: string;
  readonly label: string;
  readonly provider: string;
  readonly searchText: string;
  readonly definition: InferenceModelDefinition;
}

export const ModelPicker = memo<ModelPickerProps>(
  ({ modelGroups, model, reasoningOverride, onModelChange, onReasoningChange, disabled }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // 预算输入的未提交草稿：输入过程中不回写，失焦或回车且校验通过才提交。
    const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
    useEffect(() => { setBudgetDraft(null); }, [model, reasoningOverride, open]);
    const listRef = useRef<HTMLDivElement>(null);
    const selectedRef = useRef<HTMLButtonElement>(null);

    const flatModels = useMemo<FlatModel[]>(
      () =>
        modelGroups.flatMap((group) =>
          group.options.map((option) => ({
            value: option.value,
            label: option.label,
            provider: group.label,
            searchText: `${option.label} ${group.label} ${option.value}`.toLocaleLowerCase(),
            definition: option.definition,
          })),
        ),
      [modelGroups],
    );

    const selectedModel = useMemo(
      () => flatModels.find((option) => option.value === model),
      [flatModels, model],
    );

    const grouped = useMemo(() => {
      const needle = query.trim().toLocaleLowerCase();
      const filtered = needle
        ? flatModels.filter((option) => option.searchText.includes(needle))
        : flatModels;
      const groups = new Map<string, FlatModel[]>();
      for (const option of filtered) {
        const items = groups.get(option.provider) ?? [];
        items.push(option);
        groups.set(option.provider, items);
      }
      return [...groups.entries()];
    }, [flatModels, query]);

    const profile = selectedModel?.definition.reasoning;
    const reasoningOptions = useMemo(() => {
      if (!profile || profile.mode === 'none') return [];
      const options = getSelectableReasoningOptions(profile);
      const currentIndex = options.findIndex((option) => reasoningOptionKey(option) === reasoningOptionKey(reasoningOverride));
      // 保留当前预算数值，以及普通可选档位中隐藏的默认或关闭值。
      if (currentIndex < 0) options.unshift(reasoningOverride);
      else options[currentIndex] = reasoningOverride;
      return options;
    }, [profile, reasoningOverride]);
    const draftBudget: ReasoningSelection | null =
      budgetDraft === null ? null : { kind: 'budget', tokens: Number(budgetDraft) };
    const draftInvalid = draftBudget !== null && !isReasoningInputValid(draftBudget, profile);
    // 已保存的值可能因模型目录变更而不再受支持；只提示，不替用户改。
    const savedInvalid =
      profile !== undefined && profile.mode !== 'none' && !isReasoningInputValid(reasoningOverride, profile);

    // 打开时把选中项滚到列表中间（popover 展示后才有布局，等一帧）
    useEffect(() => {
      if (!open || query) return;
      const frame = requestAnimationFrame(() => {
        const list = listRef.current;
        const selected = selectedRef.current;
        if (!list || !selected) return;
        list.scrollTop = Math.max(
          0,
          selected.offsetTop - (list.clientHeight - selected.clientHeight) / 2,
        );
      });
      return () => cancelAnimationFrame(frame);
    }, [model, open, query]);

    const modelLabel = selectedModel?.label || model.split('::').at(-1) || t('sessionWorkbenchUi.composer.chooseModel');
    const reasoningLabel = profile?.mode === 'none'
      ? t('reasoning.none')
      : reasoningSelectionLabel(reasoningOverride, true, t);

    return (
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        placement="block-start"
        triggerClassName={styles.modelTrigger}
        trigger={
          <button
            type="button"
            className={`${styles.pill} ${styles.pillShrink}`}
            disabled={disabled}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t('sessionWorkbenchUi.composer.modelControlAria', {
              model: modelLabel,
              reasoning: reasoningLabel,
            })}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={styles.pillStrong}>{modelLabel}</span>
            {reasoningLabel && <span className={styles.pillSoft}>{reasoningLabel}</span>}
            <ChevronDown size={11} className={styles.pillChevron} />
          </button>
        }
      >
        <div className={styles.modelPanel}>
          <div className={styles.searchBox}>
            <Search size={12} />
            <input
              className={styles.searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sessionWorkbenchUi.composer.searchModelOrProvider')}
              aria-label={t('sessionWorkbenchUi.composer.searchModel')}
            />
          </div>

          <div ref={listRef} className={styles.modelList}>
            {grouped.length === 0 && (
              <div className={styles.panelEmpty}>{t('sessionWorkbenchUi.composer.noModelMatches')}</div>
            )}
            {grouped.map(([provider, options]) => (
              <div key={provider} className={styles.modelGroup}>
                <div className={styles.modelGroupLabel}>{provider}</div>
                {options.map((option) => {
                  const selected = option.value === model;
                  return (
                    <button
                      key={option.value}
                      ref={selected ? selectedRef : undefined}
                      type="button"
                      className={styles.option}
                      data-selected={selected ? 'true' : undefined}
                      onClick={() => {
                        void onModelChange(option.value);
                        setQuery('');
                      }}
                    >
                      <span className={styles.optionLabel}>{option.label}</span>
                      {selected && <Check size={12} className={styles.optionCheck} />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className={styles.reasoningSection}>
            <div className={styles.sectionLabel}>{t('sessionWorkbenchUi.composer.reasoningLevel')}</div>
            {!profile || profile.mode === 'none' ? (
              <div className={styles.panelNote}>{t('sessionWorkbenchUi.composer.reasoningUnavailable')}</div>
            ) : (
              <>
                <div className={styles.reasoningChips}>
                  {reasoningOptions.map((option) => {
                    const selected = reasoningOptionKey(reasoningOverride) === reasoningOptionKey(option);
                    return (
                      <button
                        key={reasoningOptionKey(option)}
                        type="button"
                        className={styles.chip}
                        data-selected={selected ? 'true' : undefined}
                        onClick={() => void onReasoningChange(option)}
                      >
                        {reasoningSelectionLabel(option, false, t)}
                      </button>
                    );
                  })}
                </div>
                {reasoningOverride.kind === 'budget' && (
                  <div className={styles.budgetRow}>
                    <input
                      type="number"
                      className={styles.budgetInput}
                      min={profile.minBudgetTokens ?? 1}
                      max={profile.maxBudgetTokens}
                      step={1}
                      value={budgetDraft ?? reasoningOverride.tokens}
                      onChange={(event) => setBudgetDraft(event.target.value)}
                      onBlur={() => {
                        if (draftBudget === null || !isReasoningInputValid(draftBudget, profile)) return;
                        void onReasoningChange(draftBudget);
                        setBudgetDraft(null);
                      }}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                      aria-invalid={draftInvalid}
                      aria-label={t('sessionWorkbenchUi.composer.reasoningBudget')}
                    />
                    <span className={styles.panelNote}>tokens</span>
                  </div>
                )}
                {(savedInvalid || draftInvalid) && (
                  <div className={styles.panelNote} role="alert">{t('agentManagement.reasoningInvalid')}</div>
                )}
                {profile.mandatory && (
                  <div className={styles.panelNote}>
                    <LockKeyhole size={11} /> {t('sessionWorkbenchUi.composer.reasoningRequired')}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Popover>
    );
  },
);

ModelPicker.displayName = 'ModelPicker';
