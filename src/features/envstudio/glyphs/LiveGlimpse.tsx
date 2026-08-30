/**
 * EnvStudio · 实时画面：消费 useGlimpse 的快照帧；
 * 无帧/失联时回退到金属盘封面 + LIVE 角标降级。
 * hud 打开时角标下方多一行取帧遥测（帧率/分辨率/帧体积）——主屏专用，预监砖不开。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGlimpse } from '../data/glimpse';
import { GlowDot, type DotMood } from './GlowDot';
import { MetalDisc } from './MetalDisc';
import styles from '../studio.module.css';

interface LiveGlimpseProps {
  browserId: string | undefined;
  intervalMs: number;
  mood: DotMood;
  caption: string;
  alt: string;
  /** 是否显示取帧遥测行（主屏 HUD） */
  hud?: boolean;
  /** 画面进入过期态时通知上层（用于核对环境是否已在别处停止） */
  onLapse?: () => void;
}

export const LiveGlimpse: React.FC<LiveGlimpseProps> = ({
  browserId,
  intervalMs,
  mood,
  caption,
  alt,
  hud = false,
  onLapse,
}) => {
  const { t } = useTranslation();
  const { src, stale, pulse } = useGlimpse(browserId, intervalMs, onLapse);
  // 帧分辨率：ScreenFrame 不带尺寸字段，从解码后的 <img> 读
  const [frameDims, setFrameDims] = useState<string | null>(null);

  return (
    <>
      {src ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={stale ? { opacity: 0.45 } : undefined}
          onLoad={(event) => {
            const el = event.currentTarget;
            setFrameDims(`${el.naturalWidth}×${el.naturalHeight}`);
          }}
        />
      ) : (
        <span className={styles.idleCover}>
          <MetalDisc
            label={browserId
              ? t('environmentUi.preview.live')
              : t('environmentUi.monitor.idle')}
          />
        </span>
      )}
      <span className={styles.viewCap}>
        <GlowDot mood={mood} size={5} />
        {[
          stale ? t('environmentUi.liveView.stale', { caption }) : caption,
          ...(hud && pulse
            ? [
                `${pulse.fps.toFixed(1)} FPS`,
                ...(frameDims ? [frameDims] : []),
                `${Math.round(pulse.frameKb)} KB`,
                `${Math.round(pulse.grabMs)} ms`,
              ]
            : []),
        ].join(' · ')}
      </span>
    </>
  );
};
