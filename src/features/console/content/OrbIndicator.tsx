/**
 * OrbIndicator —— Think / Working 活动中的自有指示图形（Lumen「Orbs」法则）。
 *
 * orbit 用环流表示持续工作；expanding 在中心与圆环之间舒展，表示思考展开。
 * 它只在活动中存在，完成态由前置开合箭头接棒。颜色吃 currentColor，
 * 由挂载处的图标槽给色。
 */

import { memo } from 'react';

import styles from './orbIndicator.module.css';

const DOT_COUNT = 8;
const INDEXES = Array.from({ length: DOT_COUNT }, (_, index) => index);

export const OrbIndicator = memo<{
  readonly size?: number;
  readonly variant?: 'orbit' | 'expanding';
}>(({ size = 14, variant = 'orbit' }) => (
  <span
    className={styles.orb}
    data-orb-variant={variant}
    style={{ inlineSize: size, blockSize: size }}
    aria-hidden
  >
    {INDEXES.map((index) => (
      <i key={index} style={{ '--orb-i': index } as React.CSSProperties} />
    ))}
  </span>
));

OrbIndicator.displayName = 'OrbIndicator';
