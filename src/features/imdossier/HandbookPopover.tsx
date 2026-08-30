/**
 * 使用指引（双玻璃名册档案）:
 * - `GuideSteps`:指引正文渲染(步骤序号灯/琥珀注意事项/外链),
 *   被档案空态、名册「?」浮层、凭证区渠道折叠三处共用
 * - `HandbookPopover`:名册页首「?」按钮 + 锚定浮层(页级三步指引)
 * - `ChannelGuideFold`:凭证区内的渠道级配置指引折叠
 *
 * 指引数据消费 shared 层 SetupGuide 结构(channel-setup-guides 文案归远端)。
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, CircleHelp, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SetupGuide } from '../../../shared/types/setup-guide';
import styles from './dossier.module.css';

const visit = (url: string): void => {
  void window.piskie.desktop.system.openExternal(url);
};

export const GuideSteps: React.FC<{ readonly guide: SetupGuide }> = ({ guide }) => {
  const { t } = useTranslation();
  return (
    <>
    {guide.steps.map((step, index) => (
      <div key={step.title} className={styles.stepRow}>
        <span className={styles.stepNum}>{index + 1}</span>
        <span className={styles.stepMain}>
          <b>{step.title}</b>
          {step.description}
          {step.link && (
            <>
              {' '}
              <button type="button" className={styles.stepLink} onClick={() => visit(step.link!.url)}>
                {step.link.text}
                <ExternalLink size={9} />
              </button>
            </>
          )}
        </span>
      </div>
    ))}

    {guide.notes && guide.notes.length > 0 && (
      <div className={styles.noteBox}>
        {guide.notes.map((note) => (
          <div key={note} className={styles.noteLine}>
            {note}
          </div>
        ))}
      </div>
    )}

    {(guide.consoleURL || guide.links?.length) && (
      <div className={styles.linkRack}>
        {guide.consoleURL && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnQuiet}`}
            onClick={() => visit(guide.consoleURL)}
          >
            {t('imPlugin.guide.channelConsoleAction')} <ExternalLink size={10} />
          </button>
        )}
        {guide.links?.map((link) => (
          <button
            key={link.url}
            type="button"
            className={`${styles.btn} ${styles.btnQuiet}`}
            onClick={() => visit(link.url)}
          >
            {link.text} <ExternalLink size={10} />
          </button>
        ))}
      </div>
    )}
    </>
  );
};

/** 名册页首「?」:页级指引浮层 */
export const HandbookPopover: React.FC<{ readonly guide: SetupGuide }> = ({ guide }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  return (
    <span ref={wrapRef} className={styles.popWrap}>
      <button
        type="button"
        className={styles.orb}
        aria-expanded={open}
        aria-label={t('imPlugin.guide.handbookLabel')}
        title={t('imPlugin.guide.handbookLabel')}
        onClick={() => setOpen((current) => !current)}
      >
        <CircleHelp size={14} />
      </button>
      {open && (
        <div className={styles.popCard} role="dialog" aria-label={t('imPlugin.guide.handbookLabel')}>
          <div className={styles.popCap}>
            {t('imPlugin.guide.handbookSummary')}<span className={styles.capSpring} />
          </div>
          <div className={styles.popBody}>
            <GuideSteps guide={guide} />
          </div>
        </div>
      )}
    </span>
  );
};

/** 凭证区内的渠道级配置指引折叠 */
export const ChannelGuideFold: React.FC<{ readonly guide: SetupGuide }> = ({ guide }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        className={styles.foldHead}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {t('imPlugin.guide.channelInstructions')}
        <ChevronRight size={11} className={styles.foldCaret} />
      </button>
      {open && (
        <div className={styles.foldBody}>
          <GuideSteps guide={guide} />
        </div>
      )}
    </div>
  );
};
