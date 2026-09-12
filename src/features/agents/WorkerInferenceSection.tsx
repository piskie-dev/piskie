import { useState } from 'react';
import { AlertTriangle, Bot, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatModelReference, type ModelOptGroup } from '../../store/inferenceStore';
import {
  getSelectableReasoningOptions,
  reasoningOptionKey,
  reasoningSelectionLabel,
} from '../../utils/reasoning-options';
import { WorkerModelDialog } from './WorkerModelDialog';
import { chooseModel, draftProblem, type InferenceDraft } from './worker-preference-drafts';
import styles from './agent-management.module.css';

interface Props {
  value: InferenceDraft;
  groups: ModelOptGroup[];
  saving: boolean;
  edit: (value: InferenceDraft) => void;
  /** 已保存的模型当前不可用：新实例按继承创建，界面按继承展示并保留原目标供重选。 */
  degraded?: boolean;
  modelError: string | null;
  onConfigureModels: () => void;
  onRefresh: () => void;
}

/** A configuration section; its draft belongs to the current type's shared save transaction. */
export function WorkerInferenceSection(props: Props) {
  const { t } = useTranslation();
  const { value, groups, saving, edit, degraded } = props;
  const displayMode = degraded ? 'inherit' : value.mode;
  const [modelOpen, setModelOpen] = useState(false);
  const options = groups.flatMap((group) =>
    group.options.map((option) => ({ ...option, provider: group.label }))
  );
  const model =
    value.mode === 'fixed' && value.target
      ? options.find((option) => option.value === formatModelReference(value.target!))
      : undefined;
  const profile = model?.definition.reasoning;
  const reasoningOptions = profile ? getSelectableReasoningOptions(profile) : [];
  const currentReasoning = value.mode === 'fixed' ? value.reasoning : undefined;
  const currentIsSelectable =
    currentReasoning &&
    reasoningOptions.some(
      (option) => reasoningOptionKey(option) === reasoningOptionKey(currentReasoning)
    );
  const problem = draftProblem(value, groups);
  const problemText = problem ? t(`agentManagement.${problem}`) : null;
  return (
    <>
      <section className={styles.section}>
        <h3>{t('agentManagement.modelSource')}</h3>
        <div className={styles.strategies}>
          {(['inherit', 'fixed'] as const).map((mode) => (
            <button
              key={mode}
              className={styles.strategy}
              disabled={!!saving}
              aria-pressed={displayMode === mode}
              onClick={() => {
                if (degraded && mode === 'fixed') setModelOpen(true);
                else if (value.mode !== mode) edit({ mode });
              }}
            >
              <span className={styles.radio}>{value.mode === mode && <span />}</span>
              <span>
                <strong>{t(`agentManagement.${mode}`)}</strong>
                <small>{t(`agentManagement.${mode}Description`)}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
      {degraded ? (
        <div className={styles.warning} role="status">
          <AlertTriangle size={16} />
          <div>
            <strong>{t('agentManagement.degradedTitle')}</strong>
            <p>
              {t('agentManagement.degradedDescription', {
                model:
                  value.mode === 'fixed' && value.target
                    ? `${value.target.providerId} / ${value.target.modelId}`
                    : '',
              })}
            </p>
            <div className={styles.actions}>
              <button className={styles.button} disabled={!!saving} onClick={() => setModelOpen(true)}>
                {t('agentManagement.reselectModel')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        displayMode === 'inherit' && (
          <div className={styles.inheritNote}>
            <Bot size={20} />
            <p>{t('agentManagement.inheritNote')}</p>
          </div>
        )
      )}
      {value.mode === 'fixed' && !degraded && (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <h3>{t('agentManagement.model')}</h3>
              <button className={styles.textButton} onClick={props.onConfigureModels}>
                {t('agentManagement.configureModels')}
              </button>
            </div>
            <button
              className={styles.modelSelect}
              disabled={!!saving}
              onClick={() => setModelOpen(true)}
              aria-haspopup="dialog"
            >
              <span>
                <strong>
                  {model?.label ??
                    (value.target ? value.target.modelId : t('agentManagement.chooseModel'))}
                </strong>
                <small>
                  {model?.provider ??
                    value.target?.providerId ??
                    t('agentManagement.configuredOnly')}
                </small>
              </span>
              <ChevronDown size={16} />
            </button>
            {problem === 'chooseModel' && <p className={styles.note}>{problemText}</p>}
            {props.modelError && (
              <div className={styles.error} role="alert">
                {t('agentManagement.modelsLoadFailed')}
                <p>{props.modelError}</p>
                <button className={styles.textButton} onClick={props.onRefresh}>
                  {t('common.refresh')}
                </button>
              </div>
            )}
            {problem === 'modelUnavailable' && <p className={styles.error}>{problemText}</p>}
          </section>
          {model && (
            <section className={styles.section}>
              <h3>{t('agentManagement.reasoning')}</h3>
              {!profile || profile.mode === 'none' || reasoningOptions.length === 0 ? (
                <p className={styles.note}>{t('agentManagement.reasoningUnavailable')}</p>
              ) : (
                <>
                  <div className={styles.reasoningOptions}>
                    {reasoningOptions.map((option) => (
                      <button
                        key={reasoningOptionKey(option)}
                        className={styles.button}
                        disabled={!!saving}
                        aria-pressed={
                          !!value.reasoning &&
                          reasoningOptionKey(value.reasoning) === reasoningOptionKey(option)
                        }
                        onClick={() => edit({ ...value, reasoning: option })}
                      >
                        {reasoningSelectionLabel(option, false, t)}
                      </button>
                    ))}
                  </div>
                  {currentReasoning && !currentIsSelectable && !problem && (
                    <p className={styles.note}>
                      {t('agentManagement.currentReasoning', {
                        value: reasoningSelectionLabel(currentReasoning, false, t),
                      })}
                    </p>
                  )}
                  {value.reasoning?.kind === 'budget' && (
                    <label className={styles.budget}>
                      {t('agentManagement.budget')}
                      <input
                        type="number"
                        min={profile.minBudgetTokens ?? 1}
                        max={profile.maxBudgetTokens}
                        step={1}
                        disabled={!!saving}
                        value={value.reasoning.tokens || ''}
                        onChange={(event) =>
                          edit({
                            ...value,
                            reasoning: { kind: 'budget', tokens: Number(event.target.value) },
                          })
                        }
                        aria-invalid={problem === 'reasoningInvalid'}
                      />
                      <small>
                        {t(
                          profile.maxBudgetTokens === undefined
                            ? 'agentManagement.budgetMinimum'
                            : 'agentManagement.budgetRange',
                          { min: profile.minBudgetTokens ?? 1, max: profile.maxBudgetTokens }
                        )}
                      </small>
                    </label>
                  )}
                  <p className={styles.note}>{t('agentManagement.reasoningHint')}</p>
                  {profile.mandatory && (
                    <p className={styles.note}>
                      {t('sessionWorkbenchUi.composer.reasoningRequired')}
                    </p>
                  )}
                </>
              )}
              {problem === 'reasoningInvalid' && (
                <p className={styles.error} role="alert">
                  {problemText}
                </p>
              )}
            </section>
          )}
        </>
      )}
      <WorkerModelDialog
        open={modelOpen}
        groups={groups}
        selected={model?.value}
        onSelect={(option) => edit(chooseModel(value, option))}
        onClose={() => setModelOpen(false)}
        onConfigureModels={props.onConfigureModels}
      />
    </>
  );
}
