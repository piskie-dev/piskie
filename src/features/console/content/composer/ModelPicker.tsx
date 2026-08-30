/**
 * ModelPicker —— 会话输入器中的模型 + 思考程度选择器。
 *
 * 功能与 `components/shared/ModelReasoningControl` 一致（搜索 / 按 Provider 分组 /
 * 思考档位 / budget tokens / mandatory 锁提示），外壳用 `chrome/Popover`
 * （原生 popover，top layer + light-dismiss），会话输入器内不引 AntD 控件。
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
  resolveSelectableReasoning,
} from '../../../../utils/reasoning-options';
import { Popover } from '../../chrome/Popover';
import styles from './conversationComposer.module.css';

export interface ModelPickerProps {
  readonly modelGroups: ModelOptGroup[];
  readonly model: string;
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
  readonly defaultReasoning?: ReasoningSelection;
}

export const ModelPicker = memo<ModelPickerProps>(
  ({ modelGroups, model, onModelChange, onReasoningChange, disabled }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
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
            defaultReasoning: option.defaultReasoning,
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
    const requestedReasoning = selectedModel?.defaultReasoning ?? profile?.defaultSelection;
    const effectiveReasoning = profile
      ? resolveSelectableReasoning(profile, requestedReasoning)
      : undefined;
    const reasoningOptions = useMemo(
      () => (!profile || profile.mode === 'none' ? [] : getSelectableReasoningOptions(profile)),
      [profile],
    );

    // 目录默认档不在可选集里时自动纠正
    useEffect(() => {
      if (!requestedReasoning || !effectiveReasoning) return;
      if (reasoningOptionKey(requestedReasoning) === reasoningOptionKey(effectiveReasoning)) return;
      void onReasoningChange(effectiveReasoning);
    }, [effectiveReasoning, onReasoningChange, requestedReasoning]);

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
      : reasoningSelectionLabel(effectiveReasoning, true, t);

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
                    const selected =
                      effectiveReasoning !== undefined &&
                      reasoningOptionKey(effectiveReasoning) === reasoningOptionKey(option);
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
                {effectiveReasoning?.kind === 'budget' && (
                  <div className={styles.budgetRow}>
                    <input
                      type="number"
                      className={styles.budgetInput}
                      min={profile.minBudgetTokens ?? 1}
                      max={profile.maxBudgetTokens}
                      step={1024}
                      value={effectiveReasoning.tokens}
                      onChange={(event) => {
                        const tokens = Number(event.target.value);
                        if (Number.isFinite(tokens) && tokens > 0) {
                          void onReasoningChange({ kind: 'budget', tokens });
                        }
                      }}
                      aria-label={t('sessionWorkbenchUi.composer.reasoningBudget')}
                    />
                    <span className={styles.panelNote}>tokens</span>
                  </div>
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
