import { useLayoutEffect, useRef } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SKILL_SCOPE_KEYS } from '../skillScope';
import type { SkillComposerController } from './useSkillComposer';
import styles from './skillPicker.module.css';

export function SkillPicker({ controller }: { readonly controller: SkillComposerController }) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const { open, anchorRef, close, listId, candidates, activeIndex, loading, error, options } = controller;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!open || !panel || !anchor) return;
    panel.showPopover();
    // Viewport coordinates remain correct inside the Dock's transformed canvas.
    let frame: number;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const above = Math.max(0, rect.top - viewportTop - 16);
      const below = Math.max(0, viewportTop + height - rect.bottom - 16);
      const useAbove = above >= 96 || above >= below;
      const available = useAbove ? above : below;
      const panelWidth = Math.min(rect.width, width - 16);
      panel.style.width = `${panelWidth}px`;
      panel.style.maxHeight = `${Math.min(320, available)}px`;
      panel.style.left = `${Math.max(viewportLeft + 8, Math.min(rect.left, viewportLeft + width - panelWidth - 8))}px`;
      const panelHeight = panel.getBoundingClientRect().height;
      panel.style.top = `${useAbove ? Math.max(viewportTop + 8, rect.top - 8 - panelHeight) : rect.bottom + 8}px`;
      frame = requestAnimationFrame(place);
    };
    place();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !panel.contains(target)) close();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', dismiss, true);
      panel.hidePopover();
    };
  }, [anchorRef, close, open]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-skill-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, candidates, open]);

  if (!open) return null;
  return (
    <div
      ref={panelRef}
      popover="manual"
      className={styles.panel}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className={styles.heading} id={`${listId}-title`}>{t('sessionWorkbenchUi.composer.skills.title')}</div>
      <div id={listId} role="listbox" aria-labelledby={`${listId}-title`} aria-busy={loading} className={styles.list}>
        {candidates.map((option, index) => (
          <div
            key={option.name}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            aria-posinset={index + 1}
            aria-setsize={candidates.length}
            data-skill-index={index}
            className={styles.option}
            title={`${option.name} — ${option.description}`}
            onPointerMove={() => controller.setHighlight(index)}
            onClick={() => controller.select(option)}
          >
            <BookOpen size={14} className={styles.icon} aria-hidden />
            <span className={styles.name}>{option.name}</span>
            <span className={styles.description}>{option.description}</span>
            <span className={styles.scope}>{t(SKILL_SCOPE_KEYS[option.scope])}</span>
          </div>
        ))}
      </div>
      {loading ? (
        <div className={styles.status} role="status"><Loader2 size={14} className="animate-spin" />{t('sessionWorkbenchUi.composer.skills.loading')}</div>
      ) : error !== null ? (
        <div className={styles.status} role="alert">
          <span>{t('sessionWorkbenchUi.composer.skills.queryFailed', { error })}</span>
          <button type="button" onClick={controller.retry}>{t('sessionWorkbenchUi.composer.skills.retry')}</button>
        </div>
      ) : candidates.length === 0 ? (
        <div className={styles.status} role="status">{t(options.length === 0
          ? 'sessionWorkbenchUi.composer.skills.empty'
          : 'sessionWorkbenchUi.composer.skills.noMatches')}</div>
      ) : null}
    </div>
  );
}
