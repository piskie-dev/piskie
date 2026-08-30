/**
 * EnvStudio · 粒子球（空态舞台的主视觉）
 *
 * 斐波那契球面点阵 + Y 轴旋转投影，纯 canvas；颜色随主题取自计算样式，
 * prefers-reduced-motion 时只画静帧。
 */

import React, { useEffect, useRef } from 'react';

const POINTS = 130;
const TILT = 0.42;

export const ThinkOrb: React.FC<{ size?: number; speed?: number; punch?: boolean }> = ({
  size = 120,
  speed = 0.008,
  punch = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const golden = Math.PI * (3 - Math.sqrt(5));
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < POINTS; i++) {
      const y = 1 - (i / (POINTS - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = golden * i;
      pts.push([Math.cos(t) * r, y, Math.sin(t) * r]);
    }

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let angle = 0;
    let frame = 0;
    let disposed = false;

    const draw = () => {
      if (disposed) return;
      const w = canvas.width;
      const radius = w * 0.4;
      const center = w / 2;
      // 主题色从计算样式取，深浅切换自然生效
      const ink = getComputedStyle(canvas).color || 'rgb(237,237,242)'; // style-token-ignore（canvas 绘制兜底，非 CSS 消费）
      const match = /(\d+),\s*(\d+),\s*(\d+)/.exec(ink);
      const [r, g, b] = match ? [match[1], match[2], match[3]] : ['237', '237', '242'];

      ctx.clearRect(0, 0, w, w);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      for (const [x0, y0, z0] of pts) {
        const x = x0 * cosA + z0 * sinA;
        const z = -x0 * sinA + z0 * cosA;
        const y = y0 * Math.cos(TILT) - z * Math.sin(TILT);
        const depth = (z + 1) / 2;
        ctx.beginPath();
        ctx.arc(
          center + x * radius,
          center + y * radius,
          punch ? Math.max(w / 150, (depth * w) / 82) : Math.max(w / 240, (depth * w) / 110),
          0,
          7,
        );
        ctx.fillStyle = `rgba(${r},${g},${b},${punch ? 0.3 + depth * 0.68 : 0.1 + depth * 0.62})`;
        ctx.fill();
      }
      angle += speed;
      if (!reduced) frame = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [speed, punch]);

  return (
    <canvas
      ref={canvasRef}
      width={size * 2}
      height={size * 2}
      style={{ inlineSize: size, blockSize: size, position: 'relative' }}
      aria-hidden="true"
    />
  );
};
