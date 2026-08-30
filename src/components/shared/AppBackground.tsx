/**
 * 主题背景层：挂在 App 根部（MainLayout 之前）的全屏壁纸层。
 * 呈现完全由 CSS 变量驱动（见 appBackgroundFade.ts 的头注），
 * 本组件只做两件事：渲染层节点 + 把 app-settings 的 Renderer 投影幂等回放到 <html>
 * （首帧水合与后续变更兜底；带动效的切换由 Settings 直接调 fadeAppBackground）。
 */

import React, { useEffect, useLayoutEffect } from 'react';
import { useUIStore } from '../../store';
import {
  applyAppBackgroundVars,
  estimateImageIsLight,
} from './appBackgroundFade';
import styles from './appBackground.module.css';

const AppBackground: React.FC = () => {
  const backgroundImage = useUIStore((s) => s.backgroundImage);
  const backgroundMaskOpacity = useUIStore((s) => s.backgroundMaskOpacity);
  const backgroundIsLight = useUIStore((s) => s.backgroundIsLight);

  useLayoutEffect(() => {
    applyAppBackgroundVars(backgroundImage, backgroundMaskOpacity);
  }, [backgroundImage, backgroundMaskOpacity]);

  // 旧壁纸可能没有明暗判定结果，首次使用时补算一次。
  useEffect(() => {
    if (!backgroundImage || backgroundIsLight !== null) {
      return;
    }
    let cancelled = false;
    void estimateImageIsLight(backgroundImage).then((isLight) => {
      if (!cancelled && isLight !== null) {
        useUIStore.getState().setBackgroundIsLight(isLight);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [backgroundImage, backgroundIsLight]);

  return <div className={styles.layer} aria-hidden="true" />;
};

export default AppBackground;
