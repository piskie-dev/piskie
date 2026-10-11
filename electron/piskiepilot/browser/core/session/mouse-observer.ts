import type { Mouse } from 'puppeteer-core';

export interface ObservedMouseAction {
  readonly seq: number;
  readonly action: 'move' | 'down' | 'up';
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
  readonly clickCount: number;
  readonly timestamp: number;
}

interface Position { readonly x: number; readonly y: number }
interface Update {
  readonly seq: number;
  readonly position?: Position | null;
  readonly buttons?: number;
}
const BUTTON_FLAGS = { left: 1, right: 2, middle: 4, back: 8, forward: 16 } as const;

/**
 * Observe the project's public Mouse object without replacing its execution semantics.
 * click/reset/ordinary element drag use these same methods, including concurrent calls.
 * A stepped move exposes its successful endpoint, not Puppeteer's internal step positions.
 */
export class MouseObserver<T> {
  private position: Position | null = null;
  private buttons = 0;
  private sequence = 0;
  private readonly pending = new Map<number, Update>();
  private readonly restore: Array<() => void> = [];
  private disposed = false;

  constructor(
    mouse: Mouse,
    context: () => T,
    publish: (context: T, action: ObservedMouseAction) => void,
  ) {
    const nextSequence = () => ++this.sequence;
    const currentState = () => this.state();
    const track = (
      action: ObservedMouseAction['action'],
      update: Update,
      point: Position | null,
      clickCount: number,
      pressed: number,
      result: Promise<void>,
      binding: T,
      timestamp: number,
    ) => {
      this.pending.set(update.seq, update);
      // Return the original promise to callers; observation cannot delay or reject it.
      void result.then(() => {
        this.pending.delete(update.seq);
        if (this.disposed) return;
        if (action === 'move') this.position = point;
        if (update.buttons !== undefined) this.buttons = update.buttons;
        if (!point) return;
        try {
          publish(binding, {
            seq: update.seq, action, ...point,
            buttons: action === 'move' && update.position === null ? this.state().buttons : pressed,
            clickCount,
            timestamp: action === 'move' && update.position === null ? Date.now() : timestamp,
          });
        } catch {
          // Telemetry is a passive consumer, never an automation failure.
        }
      }, () => { this.pending.delete(update.seq); });
      return result;
    };
    this.wrap(mouse, 'move', (original) => function (this: Mouse, ...args: Parameters<Mouse['move']>) {
      const [x, y, options] = args;
      const binding = context();
      const timestamp = Date.now();
      const seq = nextSequence();
      const steps = options?.steps ?? 1;
      const pressed = currentState().buttons;
      const result = original.apply(this, args);
      // The public API also permits a zero-step no-op. Fractional steps expose no endpoint.
      if (!(steps >= 1)) return result;
      const point = Number.isInteger(steps) ? { x, y } : null;
      const stepped = steps !== 1;
      // No exact position is exposed while a multi-step move is in flight.
      return track('move', { seq, position: stepped ? null : point }, point, 0, pressed, result, binding, timestamp);
    });
    for (const method of ['down', 'up'] as const) {
      this.wrap(mouse, method, (original) => function (this: Mouse, ...args: Parameters<Mouse['down']>) {
        const binding = context();
        const timestamp = Date.now();
        const state = currentState();
        const options = args[0] ?? {};
        const flag = BUTTON_FLAGS[options.button ?? 'left'];
        const buttons = method === 'down' ? state.buttons | flag : state.buttons & ~flag;
        const seq = nextSequence();
        const result = original.apply(this, args);
        // Puppeteer's click supplies clickCount to down/up internally; its public type omits it.
        const clickCount = (options as { readonly clickCount?: number }).clickCount ?? 1;
        return track(method, { seq, buttons }, state.position, clickCount, buttons, result, binding, timestamp);
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    for (const restore of this.restore) restore();
  }

  private state(): { position: Position | null; buttons: number } {
    let position = this.position;
    let buttons = this.buttons;
    for (const update of this.pending.values()) {
      if (update.position !== undefined) position = update.position;
      if (update.buttons !== undefined) buttons = update.buttons;
    }
    return { position, buttons };
  }

  private wrap<K extends 'move' | 'down' | 'up'>(
    mouse: Mouse,
    key: K,
    create: (original: Mouse[K]) => Mouse[K],
  ): void {
    const descriptor = Object.getOwnPropertyDescriptor(mouse, key);
    const wrapped = create(mouse[key]);
    Object.defineProperty(mouse, key, { configurable: true, writable: true, value: wrapped });
    this.restore.push(() => {
      if (mouse[key] !== wrapped) return;
      if (descriptor) Object.defineProperty(mouse, key, descriptor);
      else delete (mouse as Partial<Mouse>)[key];
    });
  }
}
