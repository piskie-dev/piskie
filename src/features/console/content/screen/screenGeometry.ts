import type { ScreenFrameMapping } from '@shared/types/stream';

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** The image rectangle inside either a physical client rect or a local CSS box. */
export function containGeometry(box: FrameSize, frame: FrameSize) {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  return {
    scale,
    offsetX: (box.width - frame.width * scale) / 2,
    offsetY: (box.height - frame.height * scale) / 2,
  };
}

export function pageToLocal(
  point: { readonly x: number; readonly y: number },
  box: FrameSize,
  frame: FrameSize,
  mapping?: ScreenFrameMapping,
): { x: number; y: number } | null {
  const geometry = containGeometry(box, frame);
  if (!geometry) return null;
  const x = point.x * (mapping?.scale ?? 1) + (mapping?.offsetX ?? 0);
  const y = point.y * (mapping?.scale ?? 1) + (mapping?.offsetY ?? 0);
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x: geometry.offsetX + x * geometry.scale, y: geometry.offsetY + y * geometry.scale };
}

export function localToPage(point: { x: number; y: number }, box: FrameSize, frame: FrameSize) {
  const geometry = containGeometry(box, frame);
  if (!geometry) return null;
  const x = (point.x - geometry.offsetX) / geometry.scale;
  const y = (point.y - geometry.offsetY) / geometry.scale;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x, y };
}
