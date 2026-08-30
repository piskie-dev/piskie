/** EnvStudio · 液态金属盘：空闲环境的徽记（材质即状态——静默的是金属，亮着的是屏幕） */

import React from 'react';
import styles from '../studio.module.css';

export const MetalDisc: React.FC<{ label: string; big?: boolean; size?: number; solid?: boolean }> = ({
  label,
  big,
  size,
  solid,
}) => (
  <span
    className={`${styles.disc}${big ? ` ${styles.discBig}` : ''}`}
    style={size ? { inlineSize: size, blockSize: size } : undefined}
    aria-hidden="true"
  >
    {/* solid = 整面液态金属币（无盘芯），小尺寸下材质更醒目 */}
    {!solid && <span className={styles.discCore}>{label}</span>}
  </span>
);
