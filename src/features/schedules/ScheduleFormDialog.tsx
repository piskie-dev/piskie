import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type { ScheduleCreateInput, ScheduleUpdateInput } from '@shared/electron-contracts/schedules';
import type { ScheduleTrigger, ScheduleView } from '@shared/types/schedules';
import { Select, type SelectOption } from '../../components/shared/Select';
import { TaskDefinitionModal } from '../../components/task-definition/TaskDefinitionModal';
import { Toggle } from '../../components/task-definition/controls';
import { Dialog } from '../console/chrome/Dialog';
import {
  buildCron,
  checkCron,
  isValidTimeZone,
  nextCronRun,
  normalizeCron,
  parseCadence,
  presetOf,
  type CronPreset,
} from './cron-cadence';
import { formatRelativeDateTime } from './format';
import { fromDateTimeLocalValue, toDateTimeLocalValue } from './local-days';
import { describeTemplate } from './format';
import { definitionIdOf, orderDefinitionsByAvailability, promptOf } from './schedule-presenter';
import styles from './schedules.module.css';

export type ScheduleFormMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly view: ScheduleView };

export interface ScheduleFormDialogProps {
  readonly open: boolean;
  readonly mode: ScheduleFormMode;
  readonly definitions: readonly TaskDefinitionSnapshot[];
  /** 已被 IM Bot 绑定的模板：definitionId → Bot 名称；这些模板置灰不可选。 */
  readonly boundTemplates: ReadonlyMap<string, string>;
  readonly now: Date;
  readonly locale: string;
  readonly onClose: () => void;
  readonly onCreate: (input: ScheduleCreateInput) => Promise<void>;
  readonly onUpdate: (scheduleId: string, updates: ScheduleUpdateInput) => Promise<void>;
  readonly onOpenTemplates: () => void;
}

const NAME_MAX = 40;
const PRESETS: readonly CronPreset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'custom'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

interface FormState {
  definitionId: string;
  name: string;
  nameTouched: boolean;
  triggerKind: 'once' | 'cron';
  at: string;
  preset: CronPreset;
  time: string;
  minute: string;
  weekday: string;
  customCron: string;
  timezone: string;
  runIfMissed: boolean;
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function initialState(mode: ScheduleFormMode, now: Date): FormState {
  // 模板不预选：让用户自己挑，名称随所选模板带出。
  const base: FormState = {
    definitionId: '',
    name: '',
    nameTouched: false,
    triggerKind: 'cron',
    at: toDateTimeLocalValue(new Date(now.getTime() + 3_600_000)),
    preset: 'daily',
    time: '09:00',
    minute: '0',
    weekday: '1',
    customCron: '0 9 * * *',
    timezone: systemTimeZone(),
    runIfMissed: false,
  };
  if (mode.kind === 'create') return base;
  const { schedule } = mode.view;
  const state: FormState = {
    ...base,
    definitionId: definitionIdOf(mode.view) ?? '',
    name: schedule.name,
    nameTouched: true,
    runIfMissed: schedule.runIfMissed,
  };
  if (schedule.trigger.kind === 'once') {
    return { ...state, triggerKind: 'once', at: toDateTimeLocalValue(new Date(schedule.trigger.at)) };
  }
  const cadence = parseCadence(schedule.trigger.expression);
  const preset = presetOf(cadence);
  return {
    ...state,
    triggerKind: 'cron',
    timezone: schedule.trigger.timezone,
    preset,
    customCron: schedule.trigger.expression,
    time: 'hour' in cadence ? `${pad(cadence.hour)}:${pad(cadence.minute)}` : state.time,
    minute: cadence.kind === 'hourly' ? String(cadence.minute) : state.minute,
    weekday: cadence.kind === 'weekly' ? String(cadence.weekday) : state.weekday,
  };
}

type FormError =
  | 'templateRequired' | 'nameRequired' | 'nameTooLong' | 'atInvalid' | 'atPast'
  | 'cronFieldCount' | 'cronSyntax' | 'cronNever' | 'timezone';

function resolveTrigger(state: FormState, now: Date): { trigger: ScheduleTrigger } | { error: FormError } {
  if (state.triggerKind === 'once') {
    const at = fromDateTimeLocalValue(state.at);
    if (!at) return { error: 'atInvalid' };
    if (at.getTime() <= now.getTime()) return { error: 'atPast' };
    return { trigger: { kind: 'once', at: at.toISOString() } };
  }
  if (!isValidTimeZone(state.timezone)) return { error: 'timezone' };
  let expression: string;
  if (state.preset === 'custom') {
    expression = normalizeCron(state.customCron);
  } else {
    const [hourText = '0', minuteText = '0'] = state.time.split(':');
    expression = buildCron(state.preset, {
      hour: Number(hourText),
      minute: state.preset === 'hourly' ? Number(state.minute) : Number(minuteText),
      weekday: Number(state.weekday),
    });
  }
  const problem = checkCron(expression, state.timezone);
  if (problem === 'field-count') return { error: 'cronFieldCount' };
  if (problem === 'syntax') return { error: 'cronSyntax' };
  if (problem === 'never') return { error: 'cronNever' };
  if (problem === 'timezone') return { error: 'timezone' };
  return { trigger: { kind: 'cron', expression, timezone: state.timezone } };
}

export function ScheduleFormDialog(props: ScheduleFormDialogProps) {
  const { t } = useTranslation();
  const { mode, definitions, now, locale } = props;
  const [state, setState] = useState<FormState>(() => initialState(mode, now));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);

  // 表单状态只在挂载时从 mode 取一次；页面每次打开都重新挂载这个组件，关闭不保留草稿。

  const editing = mode.kind === 'edit' ? mode.view : null;
  const agentOwned = editing !== null && definitionIdOf(editing) === undefined;
  const template = definitions.find((item) => item.definitionId === state.definitionId);
  const prompt = agentOwned && editing ? promptOf(editing, definitions) : template?.promptTemplate;

  const update = useCallback((patch: Partial<FormState>) => {
    setState((current) => ({ ...current, ...patch }));
    setError(null);
  }, []);

  const pickTemplate = (definitionId: string, created?: TaskDefinitionSnapshot) => {
    const next = definitions.find((item) => item.definitionId === definitionId) ?? created;
    setState((current) => ({
      ...current,
      definitionId,
      name: current.nameTouched ? current.name : (next?.name.slice(0, NAME_MAX) ?? current.name),
    }));
    setError(null);
  };

  const resolved = useMemo(() => resolveTrigger(state, now), [state, now]);
  const preview = useMemo(() => {
    if ('error' in resolved) return null;
    if (resolved.trigger.kind === 'once') {
      return { expression: null, next: new Date(resolved.trigger.at) };
    }
    return {
      expression: resolved.trigger.expression,
      next: nextCronRun(resolved.trigger.expression, resolved.trigger.timezone, now),
    };
  }, [resolved, now]);

  const timezoneOptions = useMemo(() => {
    const system = systemTimeZone();
    const zones = new Set<string>([system, state.timezone]);
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    for (const zone of supported ?? []) zones.add(zone);
    return [...zones].filter(Boolean).map((zone) => ({
      value: zone,
      label: zone === system ? t('schedulesUi.form.timezoneSystem', { zone }) : zone,
    }));
  }, [state.timezone, t]);

  const templateOptions: SelectOption<string>[] = [
    { value: '', label: t('schedulesUi.form.templatePlaceholder'), disabled: true },
    ...orderDefinitionsByAvailability(definitions, props.boundTemplates).map((item) => {
      const bot = props.boundTemplates.get(item.definitionId);
      return {
        value: item.definitionId,
        label: item.name,
        ...(bot ? { disabled: true, hint: t('schedulesUi.form.boundToBot', { name: bot }) } : {}),
      };
    }),
  ];
  const weekdayOptions = WEEKDAYS.map((day) => ({
    value: String(day),
    label: t('schedulesUi.form.weekdayOption', { weekday: t(`schedulesUi.weekday.${day}`) }),
  }));

  const submit = async () => {
    const name = state.name.trim();
    if (!agentOwned && !state.definitionId) return setError(t('schedulesUi.form.error.templateRequired'));
    if (!name) return setError(t('schedulesUi.form.error.nameRequired'));
    if (name.length > NAME_MAX) return setError(t('schedulesUi.form.error.nameTooLong'));
    if ('error' in resolved) return setError(t(`schedulesUi.form.error.${resolved.error}`));
    setSubmitting(true);
    try {
      if (editing) {
        const updates: ScheduleUpdateInput = { name, trigger: resolved.trigger, runIfMissed: state.runIfMissed };
        if (!agentOwned && definitionIdOf(editing) !== state.definitionId) {
          updates.action = { kind: 'new_run', launch: { kind: 'definition', definitionId: state.definitionId } };
        }
        await props.onUpdate(editing.schedule.scheduleId, updates);
      } else {
        await props.onCreate({
          name,
          trigger: resolved.trigger,
          runIfMissed: state.runIfMissed,
          action: { kind: 'new_run', launch: { kind: 'definition', definitionId: state.definitionId } },
        });
      }
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog
        open={props.open}
        onClose={props.onClose}
        title={t(editing ? 'schedulesUi.form.editTitle' : 'schedulesUi.form.createTitle')}
        width={600}
        bodyClassName={styles.dialogBody}
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {agentOwned ? (
            <div className={styles.note}>
              <AlertTriangle size={14} />
              <span>{t('schedulesUi.form.noteAgent')}</span>
            </div>
          ) : (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('schedulesUi.form.template')}
                <button type="button" className={styles.link} onClick={() => setTemplateModalOpen(true)}>
                  {t('schedulesUi.form.newTemplate')}
                </button>
              </span>
              <Select
                variant="field"
                className={styles.select}
                value={state.definitionId}
                options={templateOptions}
                onChange={pickTemplate}
                ariaLabel={t('schedulesUi.form.template')}
              />
              {template && (
                <div className={styles.templateCard}>
                  <div className={styles.templateText}>
                    <strong>{template.name}</strong>
                    <small>{describeTemplate(template, t)}</small>
                  </div>
                  <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={props.onOpenTemplates}>
                    {t('schedulesUi.form.manageTemplates')}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="schedule-form-name">
              {t('schedulesUi.form.name')}
              <em className={styles.muted}>{t('schedulesUi.form.nameHint')}</em>
            </label>
            <input
              id="schedule-form-name"
              className={styles.input}
              value={state.name}
              maxLength={NAME_MAX}
              onChange={(event) => update({ name: event.target.value, nameTouched: true })}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('schedulesUi.form.trigger')}</span>
            <div className={styles.seg} role="group" aria-label={t('schedulesUi.form.trigger')}>
              <button type="button" aria-pressed={state.triggerKind === 'once'} onClick={() => update({ triggerKind: 'once' })}>
                {t('schedulesUi.form.once')}
              </button>
              <button type="button" aria-pressed={state.triggerKind === 'cron'} onClick={() => update({ triggerKind: 'cron' })}>
                {t('schedulesUi.form.cron')}
              </button>
            </div>
          </div>

          {state.triggerKind === 'once' ? (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="schedule-form-at">{t('schedulesUi.form.at')}</label>
              <input
                id="schedule-form-at"
                className={`${styles.input} ${styles.mono}`}
                type="datetime-local"
                value={state.at}
                min={toDateTimeLocalValue(now)}
                onChange={(event) => update({ at: event.target.value })}
              />
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('schedulesUi.form.preset.label')}</span>
                <div className={styles.presets} role="group" aria-label={t('schedulesUi.form.preset.label')}>
                  {PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={state.preset === preset}
                      onClick={() => update({ preset })}
                    >
                      {t(`schedulesUi.form.preset.${preset}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.row2}>
                {state.preset === 'custom' ? (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="schedule-form-cron">
                      {t('schedulesUi.form.cronExpression')}
                      <em className={styles.muted}>{t('schedulesUi.form.cronHint')}</em>
                    </label>
                    <input
                      id="schedule-form-cron"
                      className={`${styles.input} ${styles.mono}`}
                      value={state.customCron}
                      spellCheck={false}
                      onChange={(event) => update({ customCron: event.target.value })}
                    />
                  </div>
                ) : state.preset === 'hourly' ? (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="schedule-form-minute">{t('schedulesUi.form.minute')}</label>
                    <input
                      id="schedule-form-minute"
                      className={`${styles.input} ${styles.mono}`}
                      type="number"
                      min={0}
                      max={59}
                      value={state.minute}
                      onChange={(event) => update({ minute: event.target.value })}
                    />
                  </div>
                ) : (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="schedule-form-time">{t('schedulesUi.form.time')}</label>
                    <input
                      id="schedule-form-time"
                      className={`${styles.input} ${styles.mono}`}
                      type="time"
                      value={state.time}
                      onChange={(event) => update({ time: event.target.value })}
                    />
                  </div>
                )}
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('schedulesUi.form.timezone')}</span>
                  <Select
                    variant="field"
                    className={styles.select}
                    value={state.timezone}
                    options={timezoneOptions}
                    onChange={(timezone) => update({ timezone })}
                    ariaLabel={t('schedulesUi.form.timezone')}
                  />
                </div>
              </div>
              {state.preset === 'weekly' && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('schedulesUi.form.weekdayLabel')}</span>
                  <Select
                    variant="field"
                    className={styles.select}
                    value={state.weekday}
                    options={weekdayOptions}
                    onChange={(weekday) => update({ weekday })}
                    ariaLabel={t('schedulesUi.form.weekdayLabel')}
                  />
                </div>
              )}
            </>
          )}

          <div className={styles.preview} data-tone={'error' in resolved ? 'error' : undefined}>
            <CalendarClock size={14} />
            {'error' in resolved ? (
              <span>{t(`schedulesUi.form.error.${resolved.error}`)}</span>
            ) : (
              <>
                {preview?.expression && (
                  <>
                    <span>{t('schedulesUi.form.previewCron')} <code className={styles.mono}>{preview.expression}</code></span>
                    <span>·</span>
                  </>
                )}
                <span>
                  {t('schedulesUi.form.previewNext')}{' '}
                  <code>{preview?.next ? formatRelativeDateTime(preview.next, now, locale, t) : t('schedulesUi.form.previewNone')}</code>
                </span>
              </>
            )}
          </div>

          <div className={styles.switch}>
            <div className={styles.switchText}>
              <strong>{t('schedulesUi.form.runIfMissed')}</strong>
              <small>{t('schedulesUi.form.runIfMissedHint')}</small>
            </div>
            <Toggle
              on={state.runIfMissed}
              onFlip={(runIfMissed) => update({ runIfMissed })}
              ariaLabel={t('schedulesUi.form.runIfMissed')}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="schedule-form-prompt">
              {t('schedulesUi.form.prompt')}
              <em className={styles.muted}>{t(agentOwned ? 'schedulesUi.form.promptFromAgent' : 'schedulesUi.form.promptReadonly')}</em>
            </label>
            <textarea id="schedule-form-prompt" className={styles.textarea} readOnly value={prompt ?? ''} />
          </div>

          {error && <div className={styles.formError} role="alert">{error}</div>}

          <div className={styles.formFooter}>
            <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={props.onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={`${styles.button} ${styles.primary}`}
              disabled={submitting}
            >
              {t(editing ? 'schedulesUi.form.submitSave' : 'schedulesUi.form.submitCreate')}
            </button>
          </div>
        </form>
      </Dialog>
      {!agentOwned && (
        <TaskDefinitionModal
          open={templateModalOpen}
          createOnly
          onClose={() => setTemplateModalOpen(false)}
          onCreated={(definition) => {
            setTemplateModalOpen(false);
            pickTemplate(definition.definitionId, definition);
          }}
        />
      )}
    </>
  );
}
