/** EnvStudio · 无边框 pill 按钮（Lumen：明度分层，不用描边） */

import React from 'react';
import styles from '../studio.module.css';

type PillTone = 'plain' | 'prime' | 'hush' | 'halt';

const TONE_CLASS: Record<PillTone, Array<string | undefined>> = {
  plain: [styles.pill],
  prime: [styles.pill, styles.pillPrime],
  hush: [styles.pill, styles.pillHush],
  halt: [styles.pill, styles.pillHalt],
};

interface ActPillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: PillTone;
}

export const ActPill: React.FC<ActPillProps> = ({ tone = 'plain', className, ...rest }) => (
  <button type="button" {...rest} className={[...TONE_CLASS[tone], className].filter(Boolean).join(' ')} />
);
