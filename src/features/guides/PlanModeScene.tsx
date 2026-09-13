import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  ClipboardList,
  FileText,
  Folder,
  Globe,
  LoaderCircle,
  MousePointer2,
  Square,
  Zap,
} from 'lucide-react';
import { interval, planGuideFrame, typedText } from './planTimeline';
import { PLAN_GUIDE_DURATION, PLAN_GUIDE_STILL } from './planTimeline';
import { useGuideClock } from './useGuideClock';
import { paintGuideClick } from './guideClick';
import { ComposerPreview } from './ComposerPreview';
import { GateHeader, GateOption, GateFeedback } from '../console/content/gates/parts';
import gateStyles from '../console/content/gates/gates.module.css';
import threadStyles from '../console/content/thread.module.css';
import business from './businessScenes.module.css';
import styles from './guides.module.css';
import logo from '/logo-64.png';

function Mark() {
  return <img src={logo} alt="" className={`${styles.mark} app-logo-adaptive`} />;
}

export function PlanModeScene() {
  const elapsed = useGuideClock(PLAN_GUIDE_DURATION + 3200, PLAN_GUIDE_STILL + 3200);
  return (
    <PlanModeFrame
      elapsed={Math.max(0, elapsed - 3200)}
      preparationTime={elapsed < 3200 ? elapsed : undefined}
    />
  );
}

export function PlanModeFrame({
  elapsed,
  preparationTime,
}: {
  readonly elapsed: number;
  readonly preparationTime?: number;
}) {
  const { t } = useTranslation();
  const frame = planGuideFrame(elapsed);
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const motion = useRef<{
    clock: number;
    target: string;
    from: { x: number; y: number };
    position: { x: number; y: number };
    arrived: boolean;
  } | null>(null);
  const time = frame.time;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const cursor = cursorRef.current;
    if (!stage || !cursor) return;
    stage.setAttribute('inert', '');
    const draw = () => {
      const bounds = stage.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const clock = preparationTime ?? time + 3200;
      const actionTime = preparationTime ?? time;
      const actions: readonly (readonly [string, number, number])[] = preparationTime !== undefined
        ? [['workspace', 0, 800], ['task-input', 1600, 2150]]
        : [['mode', 1550, 2100], ['option', 2550, 3100], ['send', 3750, 4600],
          ['feedback', 9200, 9750], ['feedback-send', 11400, 11800], ['approve', 14500, 15200]];
      let action: (typeof actions)[number] | undefined;
      for (const candidate of actions) if (actionTime >= candidate[1]) action = candidate;
      const target = action?.[0] ?? 'hold';
      const previous = motion.current;
      if (!previous || clock < previous.clock || target !== previous.target) {
        const from = previous && clock >= previous.clock ? previous.position : { x: 0.85, y: 0.8 };
        motion.current = { clock, target, from, position: from, arrived: false };
      }
      const current = motion.current!;
      current.clock = clock;
      const point = (target: string) => {
        const element =
          target === 'feedback-send'
            ? stage.querySelector<HTMLElement>('[data-guide-target="feedback"] button')
            : stage.querySelector<HTMLElement>(`[data-guide-target="${target}"]`);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: (rect.left - bounds.left + rect.width / 2) / bounds.width,
          y: (rect.top - bounds.top + rect.height / 2) / bounds.height,
        };
      };
      if (action && !current.arrived) {
        const destination = point(action[0]);
        if (destination) {
          const progress = interval(actionTime, action[1], action[2]);
          const eased = progress * progress * (3 - 2 * progress);
          current.position = {
            x: current.from.x + (destination.x - current.from.x) * eased,
            y: current.from.y + (destination.y - current.from.y) * eased,
          };
          current.arrived = progress === 1;
        }
      }
      cursor.style.transform = `translate(${current.position.x * bounds.width - 4}px, ${current.position.y * bounds.height - 4}px)`;
      cursor.style.opacity = String(interval(clock, 0, 200));
      paintGuideClick(
        cursor,
        preparationTime ?? time,
        preparationTime === undefined ? [2150, 3300, 4750, 9800, 12000, 15800] : [1000, 2200]
      );
    };
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(stage);
    return () => resize.disconnect();
  }, [preparationTime, time, t]);

  const secondLine = t(
    frame.revised ? 'guides.plan.scene.preserveStructure' : 'guides.plan.scene.reorganize'
  );
  return (
    <div
      ref={stageRef}
      className={`${styles.stage} ${business.planStage} ${threadStyles.skin}`}
      aria-hidden="true"
      data-guide-source="ConsolePage"
      data-guide-scene={frame.scene}
      style={{ opacity: frame.opacity }}
    >
      <div className={styles.stageTop}>
        <Mark />
        <ChevronRight size={11} />
        <Folder size={12} />
        <span>{t('guides.plan.scene.workspace')}</span>
        <ChevronRight size={11} />
        <span>{t('guides.plan.scene.taskName')}</span>
      </div>
      <div className={`${styles.scene} ${styles.setup}`} hidden={frame.scene !== 'setup'}>
        <div className={styles.welcome}>
          <Mark />
          <span>{t('console.entryPromise')}</span>
        </div>
        <ComposerPreview
          value={typedText(t('guides.plan.scene.task'), frame.taskTyping)}
          workspace={preparationTime === undefined || preparationTime > 1000}
          attachment={preparationTime === undefined || preparationTime > 2600}
          plan={frame.planSelected}
        >
          <span className={styles.modeMenu} style={{ opacity: frame.menuOpen ? 1 : 0 }}>
            <span className={styles.modeOption}>
              <Zap size={13} />
              {t('sharedUi.agentParams.normal')}
            </span>
            <span
              className={`${styles.modeOption} ${styles.selectedOption}`}
              data-guide-target="option"
            >
              <ClipboardList size={13} />
              {t('sharedUi.agentParams.plan')}
              {frame.planSelected && <Check size={12} />}
            </span>
            <span className={styles.modeOption}>
              <Globe size={13} />
              {t('sharedUi.agentParams.browserSkill')}
            </span>
          </span>
        </ComposerPreview>
      </div>
      <div className={`${styles.scene} ${styles.plan}`} hidden={frame.scene !== 'plan'}>
        <div className={threadStyles.userRow}>{t('guides.plan.scene.task')}</div>
        <div
          className={`${threadStyles.card} ${business.planCard}`}
          data-guide-source="ThreadCell/plan"
        >
          <div className={threadStyles.cardHeadButton}>
            <span className={threadStyles.cardIcon}>
              <ClipboardList size={16} />
            </span>
            <span className={threadStyles.cardTitle}>{t('transcript.title.executionPlan')}</span>
            {frame.revised && (
              <span className={styles.revision}>
                <Check size={11} />
                {t('guides.plan.scene.revised')}
              </span>
            )}
          </div>
          <div className={threadStyles.cardBody}>
            <ol>
              {[t('guides.plan.scene.inspect'), secondLine, t('guides.plan.scene.quickStart')].map(
                (text, i) => (
                  <li key={i} style={{ opacity: interval(time, 5450 + i * 350, 5750 + i * 350) }}>
                    {text}
                  </li>
                )
              )}
            </ol>
          </div>
        </div>
        <div
          className={`${gateStyles.gate} ${business.planGate}`}
          data-guide-source="PlanGate"
          style={{ opacity: frame.gateOpacity }}
        >
          <GateHeader
            icon={<ClipboardList size={13} />}
            title={t('sessionWorkbenchUi.gate.planTitle')}
          />
          <div className={gateStyles.options}>
            <div className={gateStyles.actionRow} data-guide-target="approve">
              <GateOption
                ordinal={1}
                label={t('sessionWorkbenchUi.gate.approvePlan')}
                onSelect={() => {}}
              />
            </div>
            <div data-guide-target="feedback">
              <GateFeedback
                ordinal={2}
                value={
                  frame.feedbackVisible
                    ? typedText(t('guides.plan.scene.feedback'), frame.feedbackTyping)
                    : ''
                }
                placeholder={t('sessionWorkbenchUi.gate.planFeedbackPlaceholder')}
                onChange={() => {}}
                onSubmit={() => {}}
                onPaste={() => {}}
                canSubmit={frame.feedbackVisible}
              />
            </div>
          </div>
        </div>
      </div>
      <div className={`${styles.scene} ${styles.execution}`} hidden={frame.scene !== 'execution'}>
        <div className={styles.executionStatus}>
          <CircleCheck size={15} />
          {t('guides.plan.scene.approved')}
          <span className={styles.running}>
            <i />
            {t('guides.plan.scene.running')}
          </span>
        </div>
        <h3 className={styles.planTitle}>{t('guides.plan.scene.taskName')}</h3>
        <div className={`${threadStyles.actionLine} ${styles.executionItem}`}>
          <Check size={15} />
          {t('guides.plan.scene.inspect')}
        </div>
        <div className={styles.executionItem}>
          <LoaderCircle size={15} />
          {t('guides.plan.scene.preserveStructure')}
        </div>
        <div className={`${styles.executionItem} ${styles.pending}`}>
          <Circle size={15} />
          {t('guides.plan.scene.quickStart')}
        </div>
        <div className={`${threadStyles.actionLine} ${styles.activity}`}>
          <FileText size={14} />
          {t(time > 18400 ? 'guides.setup.result' : 'guides.plan.scene.readFile')}
          <code>{t('guides.plan.scene.file')}</code>
        </div>
        {time > 18400 && (
          <div className={styles.workflowReceipt}>
            <Check size={12} />
            {t('guides.setup.diff')}
          </div>
        )}
        <div className={styles.followup}>
          {t('sessionWorkbenchUi.composer.instructionPlaceholder', {
            name: t('guides.plan.scene.taskName'),
          })}
          <Square size={12} />
        </div>
      </div>
      <div className={styles.cursor} ref={cursorRef}>
        <i />
        <MousePointer2 size={28} />
      </div>
    </div>
  );
}
