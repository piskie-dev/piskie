import { SCREEN_POINTER_POLICY } from '@shared/screen-pointer';

export interface PointerPosition { readonly x: number; readonly y: number }
interface MotionEnvironment {
  readonly now: () => number;
  readonly scheduleFrame: (callback: () => void) => () => void;
  readonly publish: (position: PointerPosition) => void;
}

export function samePointerPosition(left: PointerPosition, right: PointerPosition): boolean {
  return left.x === right.x && left.y === right.y;
}

/** One visible position and one target, in page CSS pixels, independent of viewport geometry. */
export class ScreenPointerMotion {
  private position: PointerPosition | null = null;
  private target: PointerPosition | null = null;
  private cancelFrame: (() => void) | null = null;

  constructor(private readonly environment: MotionEnvironment) {}

  moveTo(target: PointerPosition, immediate = false): void {
    if (!immediate && this.target && samePointerPosition(this.target, target)) return;
    this.dispose();
    this.target = target;
    if (!this.position || immediate || samePointerPosition(this.position, target)) {
      this.update(target);
      return;
    }
    // Retarget from the last visible sample; no queued path through superseded endpoints.
    const origin = this.position;
    const startedAt = this.environment.now();
    const sample = () => {
      this.cancelFrame = null;
      const progress = Math.min(1, (this.environment.now() - startedAt) / SCREEN_POINTER_POLICY.motionMs);
      if (progress >= 1) {
        this.update(target);
        return;
      }
      const eased = SCREEN_POINTER_POLICY.motionEase(progress);
      this.update({ x: origin.x + (target.x - origin.x) * eased,
        y: origin.y + (target.y - origin.y) * eased });
      this.cancelFrame = this.environment.scheduleFrame(sample);
    };
    this.cancelFrame = this.environment.scheduleFrame(sample);
  }

  dispose(): void {
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.target = null;
  }

  private update(position: PointerPosition): void {
    this.position = position;
    this.environment.publish(position);
  }
}
