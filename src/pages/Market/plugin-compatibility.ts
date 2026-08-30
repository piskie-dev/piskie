import type { PluginCompatibility, PluginHostCapability } from '@shared/types/plugin';
import type { BadgeVariant } from '../../components/shared';

const CAPABILITY_LABEL_KEYS: Record<PluginHostCapability, string> = {
  skills: 'marketUi.compatibility.capabilitySkills',
  mcp: 'marketUi.compatibility.capabilityMcp',
  'mcp-auth': 'marketUi.compatibility.capabilityMcpAuth',
  apps: 'marketUi.compatibility.capabilityApps',
  hooks: 'marketUi.compatibility.capabilityHooks',
  commands: 'marketUi.compatibility.capabilityCommands',
  agents: 'marketUi.compatibility.capabilityAgents',
  lsp: 'marketUi.compatibility.capabilityLsp',
  monitors: 'marketUi.compatibility.capabilityMonitors',
  interface: 'marketUi.compatibility.capabilityInterface',
  'output-styles': 'marketUi.compatibility.capabilityOutputStyles',
  workflows: 'marketUi.compatibility.capabilityWorkflows',
  themes: 'marketUi.compatibility.capabilityThemes',
  channels: 'marketUi.compatibility.capabilityChannels',
};

type CompatibilityTranslator = (key: string) => string;

/** 返回 null = 没有值得告诉用户的结论（远程包要装了才知道），调用方据此整条不渲染 */
export const compatibilityLabel = (
  compatibility: PluginCompatibility,
  translate: CompatibilityTranslator,
): string | null => {
  if (compatibility.status === 'compatible') {
    return translate('marketUi.compatibility.compatible');
  }
  if (compatibility.status === 'partial') {
    return translate('marketUi.compatibility.partial');
  }
  if (compatibility.status === 'unsupported') {
    return translate('marketUi.compatibility.unsupported');
  }
  return null;
};

export const compatibilityVariant = (compatibility: PluginCompatibility): BadgeVariant => {
  if (compatibility.status === 'compatible') return 'success';
  if (compatibility.status === 'partial' || compatibility.status === 'unknown') return 'warning';
  return 'error';
};

export const capabilityLabels = (
  capabilities: PluginHostCapability[],
  translate: CompatibilityTranslator,
): string => capabilities
  .map((capability) => translate(CAPABILITY_LABEL_KEYS[capability]))
  .join(translate('marketUi.compatibility.separator'));
