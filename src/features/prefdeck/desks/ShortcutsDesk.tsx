import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {
  CONFIGURABLE_SHORTCUT_COMMAND_IDS,
  FIXED_SHORTCUT_COMMAND_IDS,
  SHORTCUT_CATALOG,
  effectiveShortcut,
  formatShortcutAria,
  formatShortcutVisual,
  type ConfigurableShortcutCommandId,
  type FixedShortcutCommandId,
  type ShortcutOverrideValidationCode,
  type ShortcutOverrides,
} from '@shared/shortcuts';

import { useShortcutScope } from '../../../shortcuts';
import { useUIStore } from '../../../store';
import {
  shortcutCaptureResult,
  shortcutCommandNameKey,
  validateShortcutDraft,
  type ShortcutDraftIssue,
} from './shortcut-model';
import styles from '../deck.module.css';

const SHORTCUTS_TITLE_ID = 'preferences-shortcuts-title';
const CAPTURE_SCOPE = Object.freeze({
  id: 'preferences-shortcut-capture',
  layer: 'exclusive-input' as const,
  blocksLowerLayers: 'all' as const,
  bindings: [],
});
const EMPTY_OVERRIDES: ShortcutOverrides = Object.freeze({});

type ShortcutRowIssue = ShortcutDraftIssue | { readonly code: 'save-failed' };
type LockedShortcutCommandId = FixedShortcutCommandId;

const ERROR_KEYS: Record<ShortcutOverrideValidationCode, string> = {
  'invalid-combo': 'settings.shortcuts.errors.invalidCombo',
  'non-canonical-combo': 'settings.shortcuts.errors.invalidCombo',
  'fixed-control-combo': 'settings.shortcuts.errors.fixedControl',
  'missing-modifier': 'settings.shortcuts.errors.missingModifier',
  'redundant-modifier': 'settings.shortcuts.errors.redundantModifier',
  'editor-reserved-combo': 'settings.shortcuts.errors.editorReserved',
  'electron-reserved-combo': 'settings.shortcuts.errors.systemReserved',
  'physical-conflict': 'settings.shortcuts.errors.physicalConflict',
};

export const ShortcutsDesk: React.FC = () => {
  const { t } = useTranslation();
  const updateShortcut = useUIStore((state) => state.updateShortcut);
  const overrides = useUIStore((state) => state.settings?.shortcuts) ?? EMPTY_OVERRIDES;
  const platform = window.piskie.desktop.system.platform;
  const [capture, setCapture] = useState<{
    readonly commandId: ConfigurableShortcutCommandId;
    readonly preview: string | null;
  } | null>(null);
  const [issues, setIssues] = useState<Partial<Record<ConfigurableShortcutCommandId, ShortcutRowIssue>>>({});
  const [saving, setSaving] = useState<ConfigurableShortcutCommandId | null>(null);
  const restoreFocusRef = useRef<ConfigurableShortcutCommandId | null>(null);
  const captureGroupRef = useRef<HTMLSpanElement>(null);
  const editButtonRefs = useRef<Partial<Record<ConfigurableShortcutCommandId, HTMLButtonElement | null>>>({});
  useShortcutScope(CAPTURE_SCOPE, capture !== null);

  useEffect(() => {
    if (!capture) return;
    const cancelFromOutside = (event: PointerEvent): void => {
      if (saving !== null) return;
      const target = event.target;
      if (target instanceof Node && captureGroupRef.current?.contains(target)) return;
      setCapture(null);
    };
    document.addEventListener('pointerdown', cancelFromOutside, true);
    return () => document.removeEventListener('pointerdown', cancelFromOutside, true);
  }, [capture, saving]);

  useEffect(() => {
    if (capture !== null || restoreFocusRef.current === null) return;
    editButtonRefs.current[restoreFocusRef.current]?.focus();
    restoreFocusRef.current = null;
  }, [capture]);

  const currentOverrides = (): Readonly<ShortcutOverrides> => (
    useUIStore.getState().settings?.shortcuts ?? EMPTY_OVERRIDES
  );

  const clearIssue = (commandId: ConfigurableShortcutCommandId): void => {
    setIssues((current) => {
      if (!current[commandId]) return current;
      const next = { ...current };
      delete next[commandId];
      return next;
    });
  };

  const setIssue = (commandId: ConfigurableShortcutCommandId, issue: ShortcutRowIssue): void => {
    setIssues((current) => ({ ...current, [commandId]: issue }));
  };

  const persistOverride = async (
    commandId: ConfigurableShortcutCommandId,
    override: string | null,
  ): Promise<boolean> => {
    setSaving(commandId);
    const updated = await updateShortcut(commandId, override);
    setSaving(null);
    if (!updated) {
      setIssue(commandId, { code: 'save-failed' });
      return false;
    }
    clearIssue(commandId);
    return true;
  };

  const closeCaptureAndRestoreFocus = (commandId: ConfigurableShortcutCommandId): void => {
    restoreFocusRef.current = commandId;
    setCapture(null);
  };

  const saveCapturedCombo = async (
    commandId: ConfigurableShortcutCommandId,
    combo: string,
  ): Promise<void> => {
    const validation = validateShortcutDraft(commandId, combo, currentOverrides(), platform);
    if (!validation.valid) {
      setIssue(commandId, validation.issue);
      return;
    }
    if (await persistOverride(commandId, validation.override)) {
      closeCaptureAndRestoreFocus(commandId);
    }
  };

  const onCaptureKeyDown = (
    commandId: ConfigurableShortcutCommandId,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || event.nativeEvent.isComposing) return;

    const result = shortcutCaptureResult(event.nativeEvent, platform);
    if (result.kind === 'modifier') {
      clearIssue(commandId);
      setCapture({ commandId, preview: result.preview });
      return;
    }
    if (result.kind === 'invalid') {
      setIssue(commandId, { code: 'invalid-combo' });
      return;
    }

    setCapture({ commandId, preview: formatShortcutVisual(result.combo, platform) });
    void saveCapturedCombo(commandId, result.combo);
  };

  const clearShortcut = async (commandId: ConfigurableShortcutCommandId): Promise<void> => {
    if (await persistOverride(commandId, null)) setCapture(null);
  };

  const restoreShortcut = async (commandId: ConfigurableShortcutCommandId): Promise<void> => {
    const validation = validateShortcutDraft(
      commandId,
      SHORTCUT_CATALOG[commandId].defaultCombos[0],
      currentOverrides(),
      platform,
    );
    if (!validation.valid) {
      setIssue(commandId, validation.issue);
      return;
    }
    if (await persistOverride(commandId, validation.override)) setCapture(null);
  };

  const issueText = (commandId: ConfigurableShortcutCommandId): string | null => {
    const issue = issues[commandId];
    if (!issue) return null;
    if (issue.code === 'save-failed') return t('settings.shortcuts.errors.saveFailed');
    if (issue.code === 'physical-conflict' && issue.conflictingCommandId) {
      return t(ERROR_KEYS[issue.code], {
        command: t(shortcutCommandNameKey(issue.conflictingCommandId)),
      });
    }
    return t(ERROR_KEYS[issue.code]);
  };

  const lockedRows = (commandIds: readonly LockedShortcutCommandId[]): React.ReactNode => (
    commandIds.map((commandId) => {
      const entry = SHORTCUT_CATALOG[commandId];
      const visualCombos = entry.defaultCombos.map((combo) => formatShortcutVisual(combo, platform));
      const ariaCombos = entry.defaultCombos.map((combo) => formatShortcutAria(combo, platform));
      return (
        <div
          key={commandId}
          className={`${styles.rowLine} ${styles.shortcutRow} ${styles.shortcutLockedRow}`}
          data-shortcut-id={commandId}
          data-locked="true"
          aria-disabled="true"
        >
          <span className={styles.rowMain}>
            <span className={styles.rowName}><span>{t(entry.nameKey)}</span></span>
            <span className={styles.rowNote}>{t(entry.scopeKey)}</span>
          </span>
          <span className={styles.shortcutControls}>
            <span
              className={styles.shortcutLock}
              role="img"
              aria-label={t('settings.shortcuts.locked')}
              title={t('settings.shortcuts.locked')}
            >
              <LockKeyhole size={13} aria-hidden="true" />
            </span>
            <span
              className={styles.shortcutReadonlyKeys}
              aria-label={ariaCombos.join(', ')}
            >
              {visualCombos.map((combo, index) => (
                <React.Fragment key={entry.defaultCombos[index]}>
                  {index > 0 && <span className={styles.shortcutSeparator} aria-hidden="true">/</span>}
                  <kbd aria-hidden="true">{combo}</kbd>
                </React.Fragment>
              ))}
            </span>
          </span>
        </div>
      );
    })
  );

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskGlyph}><Keyboard size={19} aria-hidden="true" /></span>
        <div className={styles.deskIdent}>
          <h1 id={SHORTCUTS_TITLE_ID} className={styles.deskTitle}>
            <span>{t('settings.shortcuts.pageTitle')}</span>
          </h1>
          <div className={styles.deskSub}>{t('settings.shortcuts.pageSubtitle')}</div>
        </div>
      </div>

      <div className={styles.deskBody}>
        <section className={styles.slab} aria-labelledby="shortcuts-configurable-title">
          <h2 id="shortcuts-configurable-title" className={`${styles.slabCap} ${styles.shortcutSectionTitle}`}>
            {t('settings.shortcuts.configurableSection')}
          </h2>
          {CONFIGURABLE_SHORTCUT_COMMAND_IDS.map((commandId) => {
            const entry = SHORTCUT_CATALOG[commandId];
            const effective = effectiveShortcut(commandId, overrides);
            const visual = effective ? formatShortcutVisual(effective, platform) : null;
            const aria = effective ? formatShortcutAria(effective, platform) : null;
            const isCapturing = capture?.commandId === commandId;
            const issue = issueText(commandId);
            const errorId = `shortcut-error-${commandId.replaceAll('.', '-')}`;
            const busy = saving === commandId;
            const anySaving = saving !== null;
            const captureLabel = busy
              ? t('settings.shortcuts.savingAria', { command: t(entry.nameKey) })
              : capture?.preview
                ? t('settings.shortcuts.capturePreviewAria', {
                    command: t(entry.nameKey),
                    shortcut: capture.preview,
                  })
                : t('settings.shortcuts.captureAria', { command: t(entry.nameKey) });
            return (
              <div
                key={commandId}
                className={`${styles.rowLine} ${styles.shortcutRow}`}
                data-shortcut-id={commandId}
                data-capturing={isCapturing ? 'true' : undefined}
              >
                <span className={styles.rowMain}>
                  <span className={styles.rowName}><span>{t(entry.nameKey)}</span></span>
                  <span className={styles.rowNote}>{t(entry.scopeKey)}</span>
                </span>

                <span className={styles.shortcutControls}>
                  {isCapturing ? (
                    <span
                      ref={captureGroupRef}
                      className={styles.shortcutCaptureGroup}
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget;
                        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                        setCapture(null);
                      }}
                    >
                      <button
                        type="button"
                        autoFocus
                        className={`${styles.shortcutKeyButton} ${styles.shortcutCapture}`}
                        data-action="capture"
                        aria-label={captureLabel}
                        aria-describedby={issue ? errorId : undefined}
                        aria-busy={busy}
                        aria-live="polite"
                        aria-atomic="true"
                        disabled={busy}
                        onKeyDown={(event) => onCaptureKeyDown(commandId, event)}
                      >
                        {busy
                          ? <LoaderCircle className={styles.shortcutSpin} size={14} aria-hidden="true" />
                          : capture.preview
                            ? <kbd>{capture.preview}</kbd>
                            : <span>{t('settings.shortcuts.capturePrompt')}</span>}
                      </button>
                      <button
                        type="button"
                        className={styles.shortcutIconButton}
                        aria-label={t('settings.shortcuts.cancelCapture')}
                        title={t('settings.shortcuts.cancelCapture')}
                        disabled={busy}
                        onClick={() => closeCaptureAndRestoreFocus(commandId)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      ref={(element) => {
                        editButtonRefs.current[commandId] = element;
                      }}
                      className={styles.shortcutKeyButton}
                      data-action="edit"
                      aria-label={t('settings.shortcuts.modifyAria', {
                        command: t(entry.nameKey),
                        shortcut: aria ?? t('settings.shortcuts.disabled'),
                      })}
                      aria-describedby={issue ? errorId : undefined}
                      title={t('settings.shortcuts.modify')}
                      disabled={anySaving}
                      onClick={() => {
                        clearIssue(commandId);
                        setCapture({ commandId, preview: null });
                      }}
                    >
                      {visual
                        ? <kbd aria-hidden="true">{visual}</kbd>
                        : <span aria-hidden="true">{t('settings.shortcuts.disabled')}</span>}
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                  )}

                  <button
                    type="button"
                    className={styles.shortcutIconButton}
                    data-action="clear"
                    aria-label={t('settings.shortcuts.clearAria', { command: t(entry.nameKey) })}
                    title={t('settings.shortcuts.clear')}
                    disabled={anySaving || effective === null}
                    onClick={() => void clearShortcut(commandId)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.shortcutIconButton}
                    data-action="restore"
                    aria-label={t('settings.shortcuts.restoreAria', { command: t(entry.nameKey) })}
                    title={t('settings.shortcuts.restoreDefault')}
                    disabled={anySaving || !Object.hasOwn(overrides, commandId)}
                    onClick={() => void restoreShortcut(commandId)}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                  </button>
                </span>

                {issue && <p id={errorId} className={styles.shortcutIssue} role="alert">{issue}</p>}
              </div>
            );
          })}
        </section>

        <section className={styles.slab} aria-labelledby="shortcuts-fixed-title">
          <h2 id="shortcuts-fixed-title" className={`${styles.slabCap} ${styles.shortcutSectionTitle}`}>
            {t('settings.shortcuts.fixedSection')}
          </h2>
          {lockedRows(FIXED_SHORTCUT_COMMAND_IDS)}
        </section>
      </div>
    </>
  );
};
