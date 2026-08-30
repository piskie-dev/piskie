/**
 * ModeSelector —— Agent 运行模式下拉。
 *
 * 挂载时向后端要「当前 agent 类型的可见模式」清单；取不到时退回 plan/normal。
 * 只有一档可选时整体隐藏——不给用户「能切其实不能切」的错觉。薄封装 InlineSelect。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentModeId } from '../../../shared/types';
import type { AgentModeDescriptor } from '../../../shared/electron-contracts/modes';
import { InlineSelect, type InlineOption } from './InlineSelect';

interface ModeSelectorProps {
  mode: AgentModeId;
  onChange: (mode: AgentModeId) => void;
  disabled?: boolean;
  /** 顶层 AgentSpec 名；缺省由后端按 director 决定可见模式 */
  mainAgentSpecName?: string;
  className?: string;
}

const ModeSelector: React.FC<ModeSelectorProps> = ({
  mode,
  onChange,
  disabled,
  mainAgentSpecName,
  className,
}) => {
  const { t } = useTranslation();
  const [modes, setModes] = useState<readonly AgentModeDescriptor[]>([]);

  useEffect(() => {
    let alive = true;
    const query = mainAgentSpecName ? { agentSpec: mainAgentSpecName } : undefined;
    window.piskie.modes
      .listAvailable(query)
      .then((list) => alive && setModes(list))
      .catch(() => alive && setModes([
        { id: 'plan', label: t('sharedUi.agentParams.plan'), runtimeSwitchable: true },
        { id: 'normal', label: t('sharedUi.agentParams.normal'), runtimeSwitchable: true },
      ]));
    return () => {
      alive = false;
    };
  }, [mainAgentSpecName, t]);

  // 单档不给切换入口
  if (modes.length <= 1) return null;

  const options: InlineOption[] = modes.map((descriptor) => ({
    value: descriptor.id,
    label: descriptor.id === 'plan'
      ? t('sharedUi.agentParams.plan')
      : descriptor.id === 'normal'
        ? t('sharedUi.agentParams.normal')
        : descriptor.id === 'browser-skill'
          ? t('sharedUi.agentParams.browserSkill')
          : descriptor.label,
  }));

  return (
    <InlineSelect
      value={mode}
      options={options}
      onChange={(value) => onChange(value as AgentModeId)}
      disabled={disabled}
      ariaLabel={t('sharedUi.agentParams.modeAria')}
      className={className}
    />
  );
};

export default ModeSelector;
