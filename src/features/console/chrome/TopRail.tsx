import { memo, type ReactNode } from 'react';

import styles from './topRail.module.css';

export interface TopRailProps {
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

/** 共用顶栏轨道：导航与操作区都参与真实布局。 */
export const TopRail = memo<TopRailProps>(({ children, actions }) => (
  <div className={styles.rail} data-has-actions={actions ? 'true' : undefined}>
    <div className={styles.navigation}>{children}</div>
    {actions && <div className={styles.actions}>{actions}</div>}
  </div>
));

TopRail.displayName = 'TopRail';
