/**
 * CapabilityTag - 模型能力标签（视觉/流式/工具/推理）
 *
 * 统一 Console 状态色模式：文字 100% / 背景 12% / 边框 30%。
 * 能力标签一律走本组件，不在各页面内联硬编码色。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiOutlined,
  AppstoreOutlined,
  BookOutlined,
  BulbOutlined,
  CodeOutlined,
  EyeOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { CapabilityState } from '../../../shared/types/model-catalog';

export type Capability =
  | 'vision'
  | 'streaming'
  | 'tools'
  | 'reasoning'
  | 'skill'
  | 'executable'
  | 'mcp'
  | 'plugin';

const CAPABILITY_META: Record<Capability, { icon: React.ReactNode; labelKey: string; classes: string }> = {
  vision: {
    icon: <EyeOutlined />,
    labelKey: 'sharedUi.capability.vision',
    classes: 'text-status-running border-status-running/30 bg-status-running/12',
  },
  streaming: {
    icon: <ThunderboltOutlined />,
    labelKey: 'sharedUi.capability.streaming',
    classes: 'text-cyber-primary border-cyber-primary/30 bg-cyber-primary/12',
  },
  tools: {
    icon: <ToolOutlined />,
    labelKey: 'sharedUi.capability.tools',
    classes: 'text-cyber-warning border-cyber-warning/30 bg-cyber-warning/12',
  },
  reasoning: {
    icon: <BulbOutlined />,
    labelKey: 'sharedUi.capability.reasoning',
    classes: 'text-cyber-purple border-cyber-purple/30 bg-cyber-purple/12',
  },
  skill: {
    icon: <BookOutlined />,
    labelKey: 'sharedUi.capability.skill',
    classes: 'text-cyber-accent border-cyber-accent/30 bg-cyber-accent/12',
  },
  executable: {
    icon: <CodeOutlined />,
    labelKey: 'sharedUi.capability.executable',
    classes: 'text-cyber-warning border-cyber-warning/30 bg-cyber-warning/12',
  },
  mcp: {
    icon: <ApiOutlined />,
    labelKey: 'sharedUi.capability.mcp',
    classes: 'text-status-running border-status-running/30 bg-status-running/12',
  },
  plugin: {
    icon: <AppstoreOutlined />,
    labelKey: 'sharedUi.capability.plugin',
    classes: 'text-cyber-purple border-cyber-purple/30 bg-cyber-purple/12',
  },
};

interface CapabilityTagProps {
  type: Capability;
  state?: CapabilityState;
  className?: string;
}

const stateStyles: Record<CapabilityState, string> = {
  supported: '',
  unsupported: 'text-cyber-text-muted border-line-2 bg-surface-1 opacity-65',
  unknown: 'text-status-waiting border-status-waiting/30 bg-status-waiting/12',
};

const stateSuffix: Record<CapabilityState, string> = {
  supported: '',
  unsupported: ' ×',
  unknown: ' ?',
};

const CapabilityTag: React.FC<CapabilityTagProps> = ({ type, state = 'supported', className = '' }) => {
  const { t } = useTranslation();
  const meta = CAPABILITY_META[type];
  const label = t(meta.labelKey);
  const stateLabel = t(`sharedUi.capability.${state}`);
  return (
    <span
      title={t('sharedUi.capability.stateAria', { name: label, state: stateLabel })}
      className={`inline-flex items-center gap-1 rounded-badge border px-1 text-[11px] leading-4 ${state === 'supported' ? meta.classes : stateStyles[state]} ${className}`}
    >
      {meta.icon}
      {label}{stateSuffix[state]}
    </span>
  );
};

export default CapabilityTag;
