import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LockKeyhole, Search } from 'lucide-react';
import { NumberField } from './NumberField';
import { PopShell } from './PopShell';
import type {
  ReasoningProfile,
  ReasoningSelection,
} from '../../../shared/types/reasoning';
import type { InferenceModelDefinition } from '../../../shared/types/inference';
import type { ModelOptGroup } from '../../store/inferenceStore';
import {
  getSelectableReasoningOptions,
  reasoningOptionKey,
  reasoningSelectionLabel,
  resolveSelectableReasoning,
} from '../../utils/reasoning-options';

interface ModelReasoningControlProps {
  modelGroups: ModelOptGroup[];
  model?: string;
  reasoning?: ReasoningSelection;
  onModelChange: (model: string) => void | Promise<void>;
  onReasoningChange: (selection?: ReasoningSelection) => void | Promise<void>;
  variant?: 'full' | 'compact';
  disabled?: boolean;
  className?: string;
}

interface FlatModelOption {
  value: string;
  label: string;
  provider: string;
  searchText: string;
  definition: InferenceModelDefinition;
  defaultReasoning?: ReasoningSelection;
}

function resolveReasoningProfile(definition?: InferenceModelDefinition): ReasoningProfile | undefined {
  return definition?.reasoning;
}

const ModelReasoningControl: React.FC<ModelReasoningControlProps> = ({
  modelGroups,
  model,
  reasoning,
  onModelChange,
  onReasoningChange,
  variant = 'full',
  disabled = false,
  className = '',
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /* 原生 popover 的 light-dismiss 先于 click 触发:pointerdown 时快照开合态,
     click 按快照决定开/关,否则触发器永远"关不上" */
  const wasOpenAtPointerDown = useRef(false);
  const modelListRef = useRef<HTMLDivElement>(null);
  const selectedModelRef = useRef<HTMLButtonElement>(null);

  const flatModels = useMemo<FlatModelOption[]>(() => (
    modelGroups.flatMap((group) => group.options.map((option) => ({
      value: option.value,
      label: option.label,
      provider: group.label,
      searchText: `${option.label} ${group.label} ${option.value}`.toLocaleLowerCase(),
      definition: option.definition,
      defaultReasoning: option.defaultReasoning,
    })))
  ), [modelGroups]);

  const selectedModel = useMemo(
    () => flatModels.find((option) => option.value === model),
    [flatModels, model],
  );
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? flatModels.filter((option) => option.searchText.includes(normalized))
      : flatModels;
  }, [flatModels, query]);
  const groupedModels = useMemo(() => {
    const groups = new Map<string, FlatModelOption[]>();
    for (const option of filteredModels) {
      const items = groups.get(option.provider) ?? [];
      items.push(option);
      groups.set(option.provider, items);
    }
    return [...groups.entries()];
  }, [filteredModels]);

  const profile = useMemo(
    () => resolveReasoningProfile(selectedModel?.definition),
    [selectedModel?.definition],
  );
  const requestedReasoning = reasoning
    ?? selectedModel?.defaultReasoning
    ?? profile?.defaultSelection;
  const effectiveReasoning = profile
    ? resolveSelectableReasoning(profile, requestedReasoning)
    : undefined;
  const reasoningOptions = useMemo(() => {
    if (!profile || profile.mode === 'none') return [];
    return getSelectableReasoningOptions(profile);
  }, [profile]);

  useEffect(() => {
    if (!requestedReasoning || !effectiveReasoning) return;
    if (reasoningOptionKey(requestedReasoning) === reasoningOptionKey(effectiveReasoning)) return;
    void onReasoningChange(effectiveReasoning);
  }, [effectiveReasoning, onReasoningChange, requestedReasoning]);

  useEffect(() => {
    if (!open || query) return;
    const frame = requestAnimationFrame(() => {
      const list = modelListRef.current;
      const selected = selectedModelRef.current;
      if (!list || !selected) return;
      const listRect = list.getBoundingClientRect();
      const selectedRect = selected.getBoundingClientRect();
      const centeredTop = list.scrollTop
        + selectedRect.top
        - listRect.top
        - (list.clientHeight - selectedRect.height) / 2;
      list.scrollTop = Math.max(0, centeredTop);
    });
    return () => cancelAnimationFrame(frame);
  }, [model, open, query]);

  const chooseModel = async (value: string) => {
    await onModelChange(value);
    setQuery('');
  };

  const chooseReasoning = async (selection?: ReasoningSelection) => {
    await onReasoningChange(selection);
  };

  const panel = (
    <div
      className="w-[328px] max-w-[calc(100vw-24px)] overflow-hidden rounded-control border border-line-2 bg-cyber-surface shadow-[var(--shadow-card-active)]"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="border-b border-line-1 px-3 py-2.5">
        <div className="text-[13px] font-semibold text-cyber-text">{t('sharedUi.modelControl.settings')}</div>
      </div>

      <div className="p-3">
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.12em] text-cyber-text-muted">
          {t('sharedUi.modelControl.model')}
        </label>
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-cyber-text-muted"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sharedUi.modelControl.search')}
            className="h-8 w-full rounded-control border border-line-1 bg-cyber-bg pl-8 pr-3 text-[12px] text-cyber-text outline-none transition-all duration-200 placeholder:text-cyber-text-muted focus:border-cyber-primary/60 focus:ring-2 focus:ring-cyber-primary/15"
          />
        </div>

        <div ref={modelListRef} className="custom-scrollbar mt-2 max-h-[144px] overflow-y-auto pr-1">
          {groupedModels.length > 0 ? groupedModels.map(([provider, options]) => (
            <div key={provider} className="mb-2 last:mb-0">
              <div className="sticky top-0 z-10 bg-cyber-surface px-1 py-1 text-[10px] uppercase tracking-[0.1em] text-cyber-text/70">
                {provider}
              </div>
              <div className="space-y-1">
                {options.map((option) => {
                  const selected = option.value === model;
                  return (
                    <button
                      key={option.value}
                      ref={selected ? selectedModelRef : undefined}
                      type="button"
                      onClick={() => void chooseModel(option.value)}
                      className={`flex h-8 w-full items-center gap-2 rounded-control border px-2.5 text-left transition-all duration-200 ${selected
                        ? 'border-cyber-primary/35 bg-cyber-primary/12 text-cyber-text'
                        : 'border-transparent bg-surface-1 text-cyber-text/90 hover:border-line-2 hover:bg-surface-2 hover:text-cyber-text'}`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px]">{option.label}</span>
                      {selected && <Check size={13} className="shrink-0 text-cyber-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )) : (
            <div className="flex h-16 items-center justify-center text-[11px] text-cyber-text-muted">
              {t('sharedUi.modelControl.noMatches')}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-line-1 bg-surface-1 px-3 py-3">
        <div className="mb-2 flex items-center">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-cyber-text-muted">
            {t('sharedUi.modelControl.reasoningLevel')}
          </span>
        </div>

        {!profile || profile.mode === 'none' ? (
          <div className="flex h-8 items-center rounded-control border border-line-1 bg-cyber-bg px-2.5 text-[11px] text-cyber-text/80">
            {t('sharedUi.modelControl.reasoningUnavailable')}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {reasoningOptions.map((option) => {
                const selected = effectiveReasoning !== undefined
                  && reasoningOptionKey(effectiveReasoning) === reasoningOptionKey(option);
                return (
                  <button
                    key={reasoningOptionKey(option)}
                    type="button"
                    onClick={() => void chooseReasoning(option)}
                    className={`h-8 rounded-control border px-2.5 text-[11px] transition-all duration-200 ${selected
                      ? 'border-cyber-primary/50 bg-cyber-primary/18 font-medium text-cyber-text'
                      : 'border-line-2 bg-cyber-bg text-cyber-text/85 hover:border-cyber-primary/35 hover:bg-surface-2 hover:text-cyber-text'}`}
                  >
                    {reasoningSelectionLabel(option, false, t)}
                  </button>
                );
              })}
            </div>
            {effectiveReasoning?.kind === 'budget' && (
              <div className="mt-2 flex items-center gap-2">
                <NumberField
                  min={profile.minBudgetTokens ?? 1}
                  max={profile.maxBudgetTokens}
                  step={1024}
                  value={effectiveReasoning.tokens}
                  className="w-[140px]"
                  ariaLabel={t('sharedUi.modelControl.reasoningLevel')}
                  onChange={(tokens) => void chooseReasoning({ kind: 'budget', tokens })}
                />
                <span className="text-[10px] text-cyber-text-muted">tokens</span>
              </div>
            )}
            {profile.mandatory && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cyber-text-muted">
                <LockKeyhole size={11} />
                {t('sharedUi.modelControl.reasoningRequired')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  const modelLabel = selectedModel?.label || model?.split('::').at(-1) || t('sharedUi.modelControl.chooseModel');
  const reasoningLabel = profile?.mode === 'none'
    ? t('reasoning.none')
    : reasoningSelectionLabel(effectiveReasoning, true, t);

  return (
    <PopShell
      open={open}
      onClose={() => {
        setOpen(false);
        setQuery('');
      }}
      placement="block-end"
      trigger={(
        <button
          type="button"
          disabled={disabled}
          aria-label={t('sharedUi.modelControl.controlAria', { model: modelLabel, reasoning: reasoningLabel })}
          aria-expanded={open}
          onPointerDown={() => {
            wasOpenAtPointerDown.current = open;
          }}
          onClick={() => {
            if (disabled) return;
            if (wasOpenAtPointerDown.current) {
              setOpen(false);
              setQuery('');
            } else {
              setOpen(true);
            }
          }}
          className={`inline-flex min-w-0 items-center gap-1.5 rounded-control border-0 text-cyber-text outline-none transition-all duration-200 hover:bg-surface-2 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${variant === 'compact'
            ? 'h-7 max-w-[132px] px-2 text-[11px]'
            : 'h-8 max-w-[208px] px-2.5 text-[12px]'} ${open ? 'bg-surface-2' : 'bg-transparent'} ${className}`}
        >
          <span className="min-w-0 flex-[0_1_auto] truncate text-left font-medium">{modelLabel}</span>
          <span className="shrink-0 font-semibold">{reasoningLabel}</span>
        </button>
      )}
    >
      {panel}
    </PopShell>
  );
};

export default ModelReasoningControl;
