/**
 * ApprovalModeSelector —— 工具调用的审批模式下拉（自动 / 逐次确认）。
 * 固定两档，薄封装 InlineSelect。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ApprovalMode } from '../../../shared/types';
import { InlineSelect, type InlineOption } from './InlineSelect';

interface ApprovalModeSelectorProps {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
  className?: string;
}

const ApprovalModeSelector: React.FC<ApprovalModeSelectorProps> = ({
  mode,
  onChange,
  disabled,
  className,
}) => {
  const { t } = useTranslation();
  const options: readonly InlineOption[] = [
    { value: 'auto', label: t('sharedUi.agentParams.auto') },
    { value: 'confirm', label: t('sharedUi.agentParams.confirm') },
  ];
  return (
    <InlineSelect
      value={mode}
      options={options}
      onChange={(value) => onChange(value as ApprovalMode)}
      disabled={disabled}
      ariaLabel={t('sharedUi.agentParams.approvalAria')}
      className={className}
    />
  );
};

export default ApprovalModeSelector;
