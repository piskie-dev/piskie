import type { GuideId } from './catalog';
import { useGuideClock } from './useGuideClock';
import { SceneStage } from './SceneStage';
import { ModelGuideFrame, ProxyGuideFrame } from './SettingsGuideScene';
import { ExtensionsGuideFrame, McpGuideFrame } from './MarketGuideScene';
import { BrowserGuideFrame } from './BrowserGuideScene';
import { MessagingGuideFrame } from './MessagingGuideScene';
import { TemplateGuideFrame } from './TemplateGuideScene';
import { AgentGuideFrame } from './AgentGuideScene';
import agent from '../agents/agent-management.module.css';
import picker from '../agents/worker-model-dialog.module.css';
import { AGENT_GUIDE_DURATION, AGENT_GUIDE_TIMING } from './agentGuideTiming';
import { BROWSER_BINDING_OPEN, BROWSER_BINDING_PICK, BROWSER_GUIDE_DURATION, browserGuideFrame } from './browserGuideTiming';

type WorkflowId = Exclude<GuideId, 'getting-started'>;
export const WORKFLOW_DURATION = 24_000;
const WORKFLOW_DURATIONS: Partial<Record<WorkflowId, number>> = {
  agents: AGENT_GUIDE_DURATION,
  browser: BROWSER_GUIDE_DURATION,
  templates: 36_000,
};
const AGENT_TARGETS = [
  `.${agent.typeItem}:first-child`,
  `.${agent.strategy}:last-child`,
  `.${agent.modelSelect}`,
  `.${picker.model}`,
  `.${agent.reasoningOptions} button:last-child`,
  `.${agent.footer} .${agent.primary}`,
];

export function WorkflowScene({ id }: { readonly id: WorkflowId }) {
  const duration = WORKFLOW_DURATIONS[id] ?? WORKFLOW_DURATION;
  const elapsed = useGuideClock(duration, duration - 600);
  return <WorkflowFrame id={id} elapsed={elapsed} />;
}

export function WorkflowFrame({
  id,
  elapsed,
}: {
  readonly id: WorkflowId;
  readonly elapsed: number;
}) {
  const duration = WORKFLOW_DURATIONS[id] ?? WORKFLOW_DURATION;
  const clock = Math.max(0, elapsed) % duration;
  // A scrolling creation form, followed by start / signed-in sites / task binding.
  const frame =
    id === 'browser'
      ? browserGuideFrame(clock)
      : id === 'agents'
        ? { phase: Math.floor(clock / AGENT_GUIDE_TIMING.step), time: clock % AGENT_GUIDE_TIMING.step }
        : { phase: Math.floor(clock / 6000), time: clock % 6000 };
  return (
    <SceneStage
      id={id}
      {...frame}
      fadeIn={id !== 'browser' || frame.phase === 0}
      continuousCursor={id === 'agents' || (id === 'browser' && frame.phase >= 6)}
      cursorTiming={id === 'agents'
        ? AGENT_GUIDE_TIMING
        : id === 'browser' && frame.phase >= 6
          ? frame.phase === 6 ? BROWSER_BINDING_OPEN : BROWSER_BINDING_PICK
          : undefined}
      cursorTarget={id === 'agents'
        ? AGENT_TARGETS[frame.phase]
        : id === 'browser' && frame.phase >= 6
          ? `[data-guide-target="browser-${frame.phase === 6 ? 'trigger' : 'option'}"]`
          : undefined}
    >
      {id === 'model-setup' ? (
        <ModelGuideFrame {...frame} />
      ) : id === 'image' ? (
        <ModelGuideFrame {...frame} gateway="image" />
      ) : id === 'proxy' ? (
        <ProxyGuideFrame {...frame} />
      ) : id === 'extensions' ? (
        <ExtensionsGuideFrame {...frame} />
      ) : id === 'mcp' ? (
        <McpGuideFrame {...frame} />
      ) : id === 'browser' ? (
        <BrowserGuideFrame {...frame} />
      ) : id === 'messaging' ? (
        <MessagingGuideFrame {...frame} />
      ) : id === 'agents' ? (
        <AgentGuideFrame {...frame} />
      ) : (
        <TemplateGuideFrame {...frame} />
      )}
    </SceneStage>
  );
}
