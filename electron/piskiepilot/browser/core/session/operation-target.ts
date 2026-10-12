import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import type { ScreenElementTarget } from '@shared/types/stream.js';

type Rect = ScreenElementTarget['rect'];
export type ElementGeometry = Pick<ScreenElementTarget, 'x' | 'y' | 'rect' | 'scrollX' | 'scrollY'>;

function intersect(left: Rect, right: Rect): Rect | null {
  const x = Math.max(left.x, right.x), y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Public DOM geometry in one frame's visual CSS coordinates. */
function readVisibleBox(element: Element) {
  if (!element.isConnected || !element.getClientRects().length) return null;
  const parentOf = (node: Element): Element | null => node.parentElement
    ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null);
  const axisAligned = (css: CSSStyleDeclaration): boolean => {
    const matrix = new DOMMatrixReadOnly(css.transform === 'none' ? undefined : css.transform);
    return matrix.is2D && matrix.a > 0 && matrix.d > 0 && Math.abs(matrix.b) < 1e-7 && Math.abs(matrix.c) < 1e-7
      && (css.rotate === 'none' || css.rotate === '0deg')
      && (css.scale === 'none' || css.scale.split(' ').every((value) => Number(value) > 0));
  };
  const metrics = (node: Element, css: CSSStyleDeclaration) => {
    const box = node.getBoundingClientRect();
    const left = parseFloat(css.borderLeftWidth), right = parseFloat(css.borderRightWidth);
    const top = parseFloat(css.borderTopWidth), bottom = parseFloat(css.borderBottomWidth);
    const paddingX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
    const paddingY = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    const width = parseFloat(css.width) + (css.boxSizing === 'border-box' ? 0 : left + right + paddingX);
    const height = parseFloat(css.height) + (css.boxSizing === 'border-box' ? 0 : top + bottom + paddingY);
    if (!(width > 0 && height > 0)) return null;
    const scaleX = box.width / width, scaleY = box.height / height;
    // client/offset sizes are rounded layout pixels. Preserve fractional CSS sizes when no scrollbar is present.
    const scrollbarX = node instanceof HTMLElement ? Math.max(0, node.offsetWidth - node.clientWidth - Math.round(left + right)) : 0;
    const scrollbarY = node instanceof HTMLElement ? Math.max(0, node.offsetHeight - node.clientHeight - Math.round(top + bottom)) : 0;
    const rtlInset = Math.max(0, node.clientLeft - Math.round(left));
    return { scaleX, scaleY,
      client: { x: box.x + (left + rtlInset) * scaleX, y: box.y + top * scaleY,
        width: (width - left - right - scrollbarX) * scaleX, height: (height - top - bottom - scrollbarY) * scaleY },
      content: { x: box.x + (left + parseFloat(css.paddingLeft)) * scaleX,
        y: box.y + (top + parseFloat(css.paddingTop)) * scaleY,
        width: (width - left - right - paddingX) * scaleX, height: (height - top - bottom - paddingY) * scaleY } };
  };
  const style = getComputedStyle(element);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none'
    || Number(style.opacity) === 0 || !axisAligned(style)) return null;
  const box = element.getBoundingClientRect();
  let x = Math.max(0, box.x), y = Math.max(0, box.y), right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
  for (let parent = parentOf(element); parent; parent = parentOf(parent)) {
    const css = getComputedStyle(parent);
    if (Number(css.opacity) === 0 || !axisAligned(css)) return null;
    const clipX = /(auto|scroll|hidden|clip)/.test(css.overflowX), clipY = /(auto|scroll|hidden|clip)/.test(css.overflowY);
    if (!clipX && !clipY) continue;
    const clip = metrics(parent, css)?.client;
    if (!clip) return null;
    if (clipX) { x = Math.max(x, clip.x); right = Math.min(right, clip.x + clip.width); }
    if (clipY) { y = Math.max(y, clip.y); bottom = Math.min(bottom, clip.y + clip.height); }
  }
  if (right <= x || bottom <= y) return null;
  return { rect: { x, y, width: right - x, height: bottom - y }, projection: metrics(element, style) };
}

/** Map public frame-local geometry, content insets and clipping into main-frame visual CSS pixels. */
export async function readOperationTarget(handle: ElementHandle<Element>): Promise<ElementGeometry | null> {
  const [local, viewport] = await Promise.all([
    handle.evaluate(readVisibleBox),
    handle.frame.page().mainFrame().evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY })),
  ]);
  if (!local) return null;
  let rect: Rect | null = local.rect;
  for (let frame: Frame | null = handle.frame; rect && frame?.parentFrame(); frame = frame.parentFrame()) {
    const owner = await frame.frameElement();
    if (!owner) return null;
    try {
      const box = await owner.evaluate(readVisibleBox);
      if (!box?.projection) return null;
      const { content, scaleX, scaleY } = box.projection;
      rect = intersect({ x: content.x + rect.x * scaleX, y: content.y + rect.y * scaleY,
        width: rect.width * scaleX, height: rect.height * scaleY }, content);
      if (rect) rect = intersect(rect, box.rect);
    } finally { void owner.dispose(); }
  }
  if (rect) rect = intersect(rect, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  return rect && Object.values(rect).every(Number.isFinite) ? { rect, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    scrollX: viewport.scrollX, scrollY: viewport.scrollY } : null;
}

/** Resolve the actual focus, descending open shadow roots and known cross-origin frames. */
export async function resolveOperationFocus(page: Page): Promise<ElementHandle<Element> | null> {
  let frame: Frame | null = page.mainFrame();
  while (frame) {
    const remote = await frame.evaluateHandle(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return active;
      const selection = document.getSelection();
      const anchor = selection?.rangeCount && (!selection.isCollapsed || document.designMode === 'on') ? selection.anchorNode : null;
      const element = anchor instanceof Element ? anchor : anchor?.parentElement;
      return element && element !== document.body && element !== document.documentElement ? element : null;
    });
    const handle = remote.asElement() as ElementHandle<Element> | null;
    if (!handle) { void remote.dispose(); return null; }
    const child = await handle.contentFrame().catch(() => null);
    if (!child) return handle;
    void handle.dispose();
    frame = child;
  }
  return null;
}
