/**
 * OrbIndicator —— Think / Working / 子流程活动中的自有指示图形。
 *
 * expanding 在中心与圆环之间舒展；orbit 提供环流变体。
 * 仅在活动中显示，静态图标与 currentColor 由挂载处决定。
 */

import { memo, useLayoutEffect, useRef } from 'react';

import styles from './orbIndicator.module.css';

const DOT_COUNT = 8;
const INDEXES = Array.from({ length: DOT_COUNT }, (_, index) => index);

export const OrbIndicator = memo<{
  readonly size?: number;
  readonly variant?: 'orbit' | 'expanding';
}>(({ size = 14, variant = 'orbit' }) => {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const orb = ref.current;
    if (!orb || variant !== 'expanding') return;
    const synchronize = () => {
      for (const animation of orb.getAnimations({ subtree: true })) {
        if (animation.startTime !== 0) animation.startTime = 0;
      }
    };
    // Every expanding orb, including its pseudo-elements, uses the document's epoch.
    synchronize();
    // CSS can create animations later when deferred content or reduced motion changes.
    orb.addEventListener('animationstart', synchronize);
    return () => orb.removeEventListener('animationstart', synchronize);
  }, [variant]);
  return (
    <span
      ref={ref}
      className={styles.orb}
      data-orb-variant={variant}
      style={{ inlineSize: size, blockSize: size }}
      aria-hidden
    >
      {INDEXES.map((index) => (
        <i key={index} style={{ '--orb-i': index } as React.CSSProperties} />
      ))}
    </span>
  );
});

OrbIndicator.displayName = 'OrbIndicator';
