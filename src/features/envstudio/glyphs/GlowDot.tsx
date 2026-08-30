/** EnvStudio · 状态光点：live 呼吸辉光 / hold 琥珀 / idle 熄灭 */

import React from 'react';
import styles from '../studio.module.css';

export type DotMood = 'live' | 'hold' | 'idle';

const MOOD_CLASS: Record<DotMood, string> = {
  live: `${styles.dot} ${styles.dotLive}`,
  hold: `${styles.dot} ${styles.dotHold}`,
  idle: `${styles.dot} ${styles.dotIdle}`,
};

export const GlowDot: React.FC<{ mood: DotMood; size?: number }> = ({ mood, size }) => (
  <span
    className={MOOD_CLASS[mood]}
    style={size ? { inlineSize: size, blockSize: size } : undefined}
    aria-hidden="true"
  />
);
