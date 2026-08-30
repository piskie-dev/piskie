/**
 * 隐形左坞：双轨导航之一，使用紧凑的 Lumen 尺度。
 *
 * 常态只留左缘一根呼吸光丝;鼠标推到屏幕最左缘 / 悬停·点击光丝 → 垂直玻璃坞滑出:
 * 纯目的地行(16px 图标 + 13px 标题),活跃行左缘光珠,「会话」行带运行呼吸灯;
 * 品牌行与介绍句已裁(品牌归天际栏,介绍句零信息);移出坞 / ESC / 选页即收。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavStop } from './nav-stops';
import styles from './navhub.module.css';

export interface EdgeDockProps {
  readonly stops: readonly NavStop[];
  readonly activePath: string;
  readonly onGo: (path: string) => void;
}

export const EdgeDock: React.FC<EdgeDockProps> = ({ stops, activePath, onGo }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    /* 滞回边界:贴最左缘(≤2px)展开;越过坞右侧一线(全高有效)即收起——
       不依赖坞自身 mouseleave,沿左区上下移动不会误收 */
    const CLOSE_X = 250;
    const onMove = (event: MouseEvent): void => {
      if (event.clientX <= 2) setOpen(true);
      else if (event.clientX > CLOSE_X) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className={styles.skin}>
      <button
        type="button"
        className={styles.fil}
        data-open={open ? 'true' : 'false'}
        aria-label={t('sharedUi.navigation.open')}
        onMouseEnter={() => setOpen(true)}
        onClick={() => setOpen(true)}
      />
      <nav
        className={styles.dock}
        data-open={open ? 'true' : 'false'}
        aria-label={t('sharedUi.navigation.main')}
      >
        {stops.map((stop) => (
          <button
            key={stop.path}
            type="button"
            className={styles.stopRow}
            data-on={stop.path === activePath ? 'true' : 'false'}
            onClick={() => {
              onGo(stop.path);
              setOpen(false);
            }}
          >
            <stop.Icon />
            <span className={styles.stopName}>
              {stop.title}
              {stop.live && <span className={styles.liveDot} aria-hidden />}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
};
