import type { ElementHandle, JSHandle, Page } from 'puppeteer-core';
import { SCREEN_POINTER_POLICY } from '@shared/screen-pointer.js';
import { resolveOperationFocus } from './operation-target.js';

interface Effects {
  readonly changed: boolean;
  readonly at: number;
  readonly scroll: { readonly x: number; readonly y: number };
}
interface DocumentWatch {
  read(): Effects;
  dispose(): void;
}

/** Observe outcomes in a bounded operation, including iframe and element scrolls. No script-intent inference. */
export class PageOperationFeedback {
  private constructor(
    private readonly page: Page,
    private readonly focus: ElementHandle<Element> | null,
    private readonly documents: readonly JSHandle<DocumentWatch>[],
  ) {}

  static async capture(page: Page): Promise<PageOperationFeedback> {
    const documents: JSHandle<DocumentWatch>[] = [];
    let focus: ElementHandle<Element> | null = null;
    try {
      focus = await resolveOperationFocus(page);
      for (const frame of page.frames()) {
        documents.push(await frame.evaluateHandle((maximumMs) => {
          const initial = { x: scrollX, y: scrollY };
          const roots: Array<Document | ShadowRoot> = [document];
          for (let index = 0; index < roots.length; index++) {
            for (const element of roots[index].querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
          }
          const positions = new Map<Element, { x: number; y: number }>();
          for (const root of roots) for (const element of root.querySelectorAll('*')) {
            if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
              positions.set(element, { x: element.scrollLeft, y: element.scrollTop });
            }
          }
          let changed = false, at = 0;
          const delta = { x: 0, y: 0 };
          const scrolled = (event: Event) => {
            if (!event.isTrusted) return;
            const element = event.target instanceof Element ? event.target : document.scrollingElement;
            if (element) {
              const previous = positions.get(element);
              if (!previous || previous.x !== element.scrollLeft || previous.y !== element.scrollTop) {
                changed = true; at = Date.now();
                if (previous) { delta.x += element.scrollLeft - previous.x; delta.y += element.scrollTop - previous.y; }
                positions.set(element, { x: element.scrollLeft, y: element.scrollTop });
              }
            }
          };
          for (const root of roots) root.addEventListener('scroll', scrolled, true);
          const dispose = () => {
            clearTimeout(expiry);
            for (const root of roots) root.removeEventListener('scroll', scrolled, true);
            positions.clear();
          };
          // A transport can disconnect while this document survives; listeners also release themselves.
          const expiry = setTimeout(dispose, maximumMs);
          return {
            read() {
              const moved = scrollX !== initial.x || scrollY !== initial.y;
              return { changed: changed || moved, at: at || (moved ? Date.now() : 0),
                scroll: delta.x || delta.y ? delta : { x: scrollX - initial.x, y: scrollY - initial.y } };
            },
            dispose,
          };
        }, SCREEN_POINTER_POLICY.observationMaxMs));
      }
      return new PageOperationFeedback(page, focus, documents);
    } catch (error) {
      await new PageOperationFeedback(page, focus, documents).dispose();
      throw error;
    }
  }

  async read(): Promise<{ focus: ElementHandle<Element> | null; focusChanged: boolean; effects: Effects }> {
    const rows = await Promise.all(this.documents.map((handle) => handle.evaluate((watch) => watch.read()).catch(() => null)));
    const effects = rows.reduce<Effects>((sum, row) => row ? {
      changed: sum.changed || row.changed, at: Math.max(sum.at, row.at),
      scroll: { x: sum.scroll.x + row.scroll.x, y: sum.scroll.y + row.scroll.y },
    } : sum, { changed: false, at: 0, scroll: { x: 0, y: 0 } });
    const focus = await resolveOperationFocus(this.page);
    try {
      const focusChanged = focus && this.focus ? !await focus.evaluate((element, before) => element === before, this.focus)
        : !!focus !== !!this.focus;
      return { focus, focusChanged, effects };
    } catch (error) { void focus?.dispose(); throw error; }
  }

  async dispose(): Promise<void> {
    void this.focus?.dispose();
    await Promise.all(this.documents.map(async (handle) => {
      try { await handle.evaluate((watch) => watch.dispose()); } catch { /* Navigation releases that document's listeners. */ }
      finally { void handle.dispose(); }
    }));
  }
}
