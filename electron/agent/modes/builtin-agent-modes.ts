import type { AgentModeDefinition } from './agent-mode-definition.js';

function standardMode(id: 'normal' | 'plan', label: string): AgentModeDefinition {
  return {
    descriptor: { id, label, runtimeSwitchable: true },
    systemChatAgentSpec: 'system-chat',
    isAvailableFor: (spec) => (
      spec.role === 'director'
      && spec.modules.includes('plan')
      && (id === 'plan' || spec.name !== 'browser-skill-director')
    ),
  };
}

export function createBuiltinAgentModes(): readonly AgentModeDefinition[] {
  return Object.freeze([
    standardMode('normal', 'Normal'),
    standardMode('plan', 'Plan'),
    {
      descriptor: { id: 'browser-skill', label: 'Browser Skill', runtimeSwitchable: false },
      systemChatAgentSpec: 'browser-skill-director',
      isAvailableFor: (spec) => spec.name === 'browser-skill-director',
    },
  ]);
}
