/**
 * 自由棱镜：双轨导航之一。
 *
 * 圆形光珠浮标(2026-08-25 由圆角菱形改圆):内部折射流转 + 周期扫过高光,
 * 兼全局状态灯(错误时整珠变红);
 * 可拖拽到屏幕任意位置(位移 ≥5px 判定拖拽,松手驻留并持久化),单击原地扇形展开
 * 目的地签——扇形恒朝屏幕中心一侧,贴边贴角不溢出;选页 / ESC / 点空白收拢。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavPrismSpot } from '../../store/uiStore';
import type { NavStop } from './nav-stops';
import styles from './navhub.module.css';

export interface PrismHubProps {
  readonly stops: readonly NavStop[];
  readonly activePath: string;
  readonly onGo: (path: string) => void;
  /** 全局状态色调:calm=主色,halt=告警红 */
  readonly tone: 'calm' | 'halt';
  readonly spot: NavPrismSpot | null;
  readonly onSpot: (spot: NavPrismSpot) => void;
}

const HUB_SIZE = 52;
const EDGE_GAP = 10;

function clampSpot(spot: NavPrismSpot): NavPrismSpot {
  return {
    x: Math.min(Math.max(spot.x, EDGE_GAP), window.innerWidth - HUB_SIZE - EDGE_GAP),
    y: Math.min(Math.max(spot.y, EDGE_GAP), window.innerHeight - HUB_SIZE - EDGE_GAP),
  };
}

export const PrismHub: React.FC<PrismHubProps> = ({ stops, activePath, onGo, tone, spot, onSpot }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hubRef = useRef<HTMLDivElement>(null);
  const fanRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sx: number; sy: number; ox: number; oy: number; moved: boolean;
  } | null>(null);
  /** 展开时按棱镜位置算好的扇形坐标(恒朝屏幕中心一侧) */
  const [fanSpots, setFanSpots] = useState<readonly { fx: number; fy: number }[]>([]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onDocDown = (event: PointerEvent): void => {
      if (hubRef.current && !hubRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDocDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown);
    };
  }, []);

  const layoutFan = (): void => {
    const hub = hubRef.current;
    if (!hub) return;
    const rect = hub.getBoundingClientRect();
    const cx = rect.left + HUB_SIZE / 2;
    const cy = rect.top + HUB_SIZE / 2;
    const base = Math.atan2(window.innerHeight / 2 - cy, window.innerWidth / 2 - cx);

    // ① 朝屏幕中心扇形展开,按签的实测尺寸钳回视口(贴角时两端的签不出屏)
    const halves = stops.map((_, index) => {
      const chip = fanRef.current?.children[index] as HTMLElement | undefined;
      return {
        w: (chip?.offsetWidth ?? 124) / 2 + 8,
        h: (chip?.offsetHeight ?? 40) / 2 + 8,
      };
    });
    const clampX = (x: number, i: number): number =>
      Math.min(Math.max(x, halves[i]!.w), window.innerWidth - halves[i]!.w);
    const clampY = (y: number, i: number): number =>
      Math.min(Math.max(y, halves[i]!.h), window.innerHeight - halves[i]!.h);
    const pts = stops.map((_, index) => {
      const angle = base + (index - (stops.length - 1) / 2) * (30 * Math.PI / 180);
      return {
        x: clampX(cx + Math.cos(angle) * 178, index),
        y: clampY(cy + Math.sin(angle) * 150, index),
      };
    });

    // ② 钳制可能把相邻签压到一起:AABB 分离松弛,沿穿透较小的轴推开再回钳
    for (let iter = 0; iter < 24; iter += 1) {
      let moved = false;
      for (let i = 0; i < pts.length; i += 1) {
        for (let j = i + 1; j < pts.length; j += 1) {
          const sepX = halves[i]!.w + halves[j]!.w;
          const sepY = halves[i]!.h + halves[j]!.h;
          const dx = pts[j]!.x - pts[i]!.x;
          const dy = pts[j]!.y - pts[i]!.y;
          const penX = sepX - Math.abs(dx);
          const penY = sepY - Math.abs(dy);
          if (penX <= 0 || penY <= 0) continue;
          if (penY <= penX) {
            const push = (penY / 2 + 1) * (dy >= 0 ? 1 : -1);
            pts[i]!.y = clampY(pts[i]!.y - push, i);
            pts[j]!.y = clampY(pts[j]!.y + push, j);
          } else {
            const push = (penX / 2 + 1) * (dx >= 0 ? 1 : -1);
            pts[i]!.x = clampX(pts[i]!.x - push, i);
            pts[j]!.x = clampX(pts[j]!.x + push, j);
          }
          moved = true;
        }
      }
      if (!moved) break;
    }

    setFanSpots(pts.map((pt) => ({ fx: pt.x - cx, fy: pt.y - cy })));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const hub = hubRef.current;
    if (!hub) return;
    const rect = hub.getBoundingClientRect();
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: rect.left, oy: rect.top, moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 非常规指针(如合成事件)拿不到 capture:退化为无捕获拖拽,不阻断单击
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    const hub = hubRef.current;
    if (!drag || !hub) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    setOpen(false);
    const next = clampSpot({ x: drag.ox + dx, y: drag.oy + dy });
    hub.style.left = `${next.x}px`;
    hub.style.top = `${next.y}px`;
  };

  const onPointerUp = (): void => {
    const drag = dragRef.current;
    const hub = hubRef.current;
    dragRef.current = null;
    if (!drag || !hub) return;
    if (drag.moved) {
      const rect = hub.getBoundingClientRect();
      onSpot({ x: rect.left, y: rect.top });
      return;
    }
    if (!open) layoutFan();
    setOpen((current) => !current);
  };

  const placed = spot ? clampSpot(spot) : null;
  const hubStyle: React.CSSProperties = placed
    ? { left: placed.x, top: placed.y }
    : { left: 24, bottom: 24 };

  return (
    <div
      ref={hubRef}
      className={`${styles.skin} ${styles.hub}`}
      style={hubStyle}
      data-open={open ? 'true' : 'false'}
      data-tone={tone === 'halt' ? 'halt' : undefined}
    >
      <div ref={fanRef} className={styles.fan} aria-hidden={!open}>
        {stops.map((stop, index) => (
          <button
            key={stop.path}
            type="button"
            className={styles.fanStop}
            data-on={stop.path === activePath ? 'true' : 'false'}
            style={{
              '--fx': `${fanSpots[index]?.fx ?? 0}px`,
              '--fy': `${fanSpots[index]?.fy ?? 0}px`,
              transitionDelay: open ? `${index * 32}ms` : '0ms',
            } as React.CSSProperties}
            onClick={(event) => {
              event.stopPropagation();
              onGo(stop.path);
              setOpen(false);
            }}
          >
            <stop.Icon />
            {stop.title}
            {stop.live && <span className={styles.liveDot} aria-hidden />}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={styles.prism}
        aria-label={t('sharedUi.navigation.open')}
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
};
