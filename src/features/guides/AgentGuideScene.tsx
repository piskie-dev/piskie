import { useTranslation } from 'react-i18next';
import type { ModelOptGroup } from '../../store/inferenceStore';
import type { InferenceDraft } from '../agents/worker-preference-drafts';
import { modelDefaultReasoning } from '../agents/worker-preference-drafts';
import { AgentManagementView } from '../agents/AgentManagementView';
import { WorkerModelPicker } from '../agents/WorkerModelDialog';
import picker from '../agents/worker-model-dialog.module.css';
import type { BusinessFrameProps } from './SceneStage';
import styles from './agentGuideScene.module.css';
import { AGENT_GUIDE_TIMING as timing } from './agentGuideTiming';

const noop = () => {};
const target = { providerId: 'demo-provider', modelId: 'claude-sonnet-4-6' };
const model: ModelOptGroup['options'][number] = {
  // i18n-ignore -- Official model name is shared across languages, like the live catalog.
  label: 'Claude Sonnet 4.6', value: 'demo-provider::claude-sonnet-4-6', target,
  definition: {
    id: 'demo-model', displayName: 'Claude Sonnet 4.6', kind: 'ai', lifecycle: 'active',
    compatibleDrivers: [], inputModalities: ['text', 'image'], outputModalities: ['text'],
    capabilities: { tools: true, vision: true, structuredOutput: true },
    limits: { contextWindow: 1000000, maxOutputTokens: 128000 },
    source: { kind: 'local', version: 'guide' },
    reasoning: {
      mode: 'effort', options: [{ kind: 'effort', effort: 'low' }, { kind: 'effort', effort: 'medium' }, { kind: 'effort', effort: 'high' }],
      defaultSelection: { kind: 'effort', effort: 'medium' }, mandatory: false,
      transportPreset: 'anthropic-adaptive-effort', replayPolicy: 'none',
    },
  },
};

/** Real Agent management components with isolated examples and no host callbacks. */
export function AgentGuideFrame({ phase, time }: BusinessFrameProps) {
  const { t } = useTranslation();
  const selected = phase === 0 && time < timing.click ? 'local-worker' : 'explore';
  const fixed = phase > 1 || (phase === 1 && time >= timing.click);
  // Fixed mode reveals the field; opening the picker and selecting a model are separate clicks.
  const picked = phase > 3 || (phase === 3 && time >= timing.result);
  const high = phase > 4 || (phase === 4 && time >= timing.click);
  const saved = phase > 5 || (phase === 5 && time >= timing.result);
  const inference = { target, reasoning: high ? { kind: 'effort' as const, effort: 'high' as const } : modelDefaultReasoning(model) };
  const value: InferenceDraft = fixed ? { mode: 'fixed', ...(picked ? inference : {}) } : { mode: 'inherit' };
  // i18n-ignore -- Provider brand name is not translated in the live catalog.
  const groups: ModelOptGroup[] = [{ label: 'Anthropic', options: [model] }];
  const showPicker = (phase === 2 && time >= timing.result) || (phase === 3 && !picked);
  return (
    <div className={styles.viewport} data-guide-source="AgentManagementView/WorkerModelPicker">
      <div className={styles.page} data-closeup={phase > 0 || undefined}>
        <AgentManagementView
          document={{ schemaVersion: 1, revision: 1, profiles: saved ? { explore: { inference } } : {} }}
          types={[
            { type: 'explore', description: t('guides.agents.explore') },
            { type: 'local-worker', description: t('guides.agents.local') },
            { type: 'browser-worker', description: t('guides.agents.browser') },
          ]}
          groups={groups} selected={selected}
          drafts={fixed && !saved ? { explore: { displayName: '', value, conflict: false } } : {}}
          scrollPositions={{ explore: picked ? 10_000 : 0 }} rememberScroll={noop} loading={false} saving={null}
          loadError={null} modelError={null} saveErrors={{}} savedType={saved ? 'explore' : null}
          select={noop} edit={noop} editDisplayName={noop} discard={noop} rebase={noop}
          save={async () => {}} onConfigureModels={noop} onRefresh={noop}
        />
      </div>
      {showPicker && <div className={styles.pickerScrim}>
        <div className={`${picker.dialog} ${styles.picker}`}>
          <div className={picker.body}>
            <WorkerModelPicker groups={groups} autoFocus={false} onSelect={noop} onClose={noop} onConfigureModels={noop} />
          </div>
        </div>
      </div>}
    </div>
  );
}
