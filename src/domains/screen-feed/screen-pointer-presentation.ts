import { sameScreenPage, sameScreenPageInstance, type ScreenPageIdentity, type ScreenPointer } from '@shared/types/stream';
import { isRecentScreenPress, SCREEN_POINTER_POLICY, type PresentedScreenPointer } from '@shared/screen-pointer';

interface PresentationEnvironment {
  readonly now: () => number;
  readonly unixNow: () => number;
  readonly scheduleDelay: (callback: () => void, delayMs: number) => () => void;
  readonly publish: () => void;
  readonly resume: () => void;
}

/** One viewport's presentation of the session's current observation; no event history. */
export class ScreenPointerPresentation {
  pointer: PresentedScreenPointer | null = null;
  clearId = 0;
  private framePage: ScreenPageIdentity | null = null;
  private page: ScreenPageIdentity | null = null;
  private source: ScreenPointer | null = null;
  private suppressed: ScreenPointer | null = null;
  private cancelHold: (() => void) | null = null;
  private holdCap: number | null = null;
  private clearing = false;

  constructor(private visible: boolean, private readonly environment: PresentationEnvironment) {}

  get blocked(): boolean { return this.holdCap !== null || this.clearing; }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.suppressed = this.source;
      this.clearPresentation();
      this.environment.resume();
    } else this.derive();
  }

  accept(page: ScreenPageIdentity | null, source: ScreenPointer | null): void {
    const previousPage = this.page;
    this.page = page;
    this.source = source;
    if (!this.visible) {
      this.suppressed = source;
      return;
    }
    if (!sameScreenPage(previousPage, page) && this.pointer) {
      const navigating = page && sameScreenPageInstance(this.pointer.framePage, page)
        && page.navigationSequence > this.pointer.framePage.navigationSequence;
      if (navigating && this.pointer.press
        && sameScreenPage(this.framePage, this.pointer.press.page)
        && isRecentScreenPress(this.pointer.press.timestamp, this.environment.unixNow())
        && (this.pointer.pressVisibleAt === null
          || this.environment.unixNow() - this.pointer.pressVisibleAt < SCREEN_POINTER_POLICY.navigationVisibleMs)) {
        if (this.holdCap === null) this.holdCap = this.environment.now() + SCREEN_POINTER_POLICY.navigationMaxDelayMs;
        this.scheduleHold();
        return;
      }
      if (!navigating || this.pointer.press || !sameScreenPageInstance(source?.page, page)) this.requestClear();
    }
    if (!this.blocked) this.derive();
  }

  presented(page: ScreenPageIdentity, seq: number, pressSeq: number | undefined, at: number): void {
    if (!this.visible || !this.pointer || !sameScreenPage(this.pointer.framePage, page) || this.pointer.seq !== seq) return;
    const pointer = this.pointer;
    const visibleAt = pointer.visibleAt ?? at;
    const pressVisibleAt = pointer.press && pressSeq === pointer.press.seq ? pointer.pressVisibleAt ?? at : pointer.pressVisibleAt;
    if (pointer.visibleAt === visibleAt && pointer.pressVisibleAt === pressVisibleAt) return;
    this.pointer = { ...pointer, visibleAt, pressVisibleAt };
    this.environment.publish();
    if (this.holdCap !== null) this.scheduleHold();
  }

  canDraw(page: ScreenPageIdentity | null): boolean {
    if (this.blocked) return false;
    if (this.pointer && !sameScreenPage(this.pointer.framePage, page)
      && (!sameScreenPageInstance(this.pointer.page, page) || this.pointer.press)) {
      this.requestClear();
      return false;
    }
    return true;
  }

  drawn(page: ScreenPageIdentity | null): PresentedScreenPointer | null {
    this.framePage = page;
    // The caller commits frame geometry and its derived position together.
    this.derive(false);
    return this.pointer;
  }

  cleared(clearId: number): void {
    if (!this.clearing || clearId !== this.clearId) return;
    this.clearing = false;
    this.derive();
    this.environment.resume();
  }

  reset(): void {
    this.framePage = null;
    this.page = null;
    this.source = null;
    this.suppressed = null;
    this.clearPresentation();
  }

  private clearPresentation(): void {
    this.cancelHold?.();
    this.cancelHold = null;
    this.holdCap = null;
    this.clearing = false;
    this.pointer = null;
    this.environment.publish();
  }

  dispose(): void {
    this.cancelHold?.();
    this.cancelHold = null;
    this.holdCap = null;
    this.pointer = null;
  }

  private derive(publish = true): void {
    const source = this.source;
    if (!this.visible || this.blocked || !source || !sameScreenPageInstance(source.page, this.framePage)
      || !sameScreenPage(this.framePage, this.page)) return;
    const previous = sameScreenPageInstance(this.pointer?.page, source.page) ? this.pointer : null;
    const press = source.press && sameScreenPage(source.press.page, this.framePage)
      && isRecentScreenPress(source.press.timestamp, this.environment.unixNow())
      && !(sameScreenPageInstance(source.page, this.suppressed?.page) && source.press.seq <= (this.suppressed?.press?.seq ?? 0))
      ? source.press : undefined;
    if (previous?.seq === source.seq && sameScreenPage(previous.framePage, this.framePage)
      && previous.press?.seq === press?.seq) return;
    this.pointer = { ...source, framePage: this.framePage!, press,
      visibleAt: previous?.seq === source.seq ? previous.visibleAt : null,
      pressVisibleAt: previous?.press?.seq === press?.seq ? previous?.pressVisibleAt ?? null : null };
    if (publish) this.environment.publish();
  }

  private scheduleHold(): void {
    this.cancelHold?.();
    const remaining = this.pointer?.pressVisibleAt == null ? SCREEN_POINTER_POLICY.navigationMaxDelayMs
      : Math.max(0, SCREEN_POINTER_POLICY.navigationVisibleMs - (this.environment.unixNow() - this.pointer.pressVisibleAt));
    const delay = Math.max(0, Math.min(remaining, this.holdCap! - this.environment.now()));
    this.cancelHold = this.environment.scheduleDelay(() => {
      this.cancelHold = null;
      this.holdCap = null;
      this.requestClear();
    }, delay);
  }

  private requestClear(): void {
    this.cancelHold?.();
    this.cancelHold = null;
    this.holdCap = null;
    if (this.clearing || !this.pointer) return;
    this.pointer = sameScreenPageInstance(this.pointer.page, this.page)
      && sameScreenPageInstance(this.source?.page, this.page)
      ? { ...this.pointer, press: undefined, pressVisibleAt: null } : null;
    this.clearing = true;
    this.clearId += 1;
    // Remove old-frame feedback before switching images; a live Page's arrow remains.
    this.environment.publish();
  }
}
