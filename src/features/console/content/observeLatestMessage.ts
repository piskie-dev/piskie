/** Report a read only after the latest message's end is visible in a foreground transcript. */
export function observeLatestMessage(
  viewport: HTMLElement,
  message: HTMLElement,
  onVisible: () => void,
): () => void {
  const doc = viewport.ownerDocument;
  const win = doc.defaultView!;
  let frame: number | undefined;
  let visible = false;
  const check = () => {
    frame = undefined;
    if (!visible || doc.visibilityState !== 'visible' || !doc.hasFocus()) return;
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 40) return;
    const area = viewport.getBoundingClientRect();
    const end = message.getBoundingClientRect();
    const top = Math.max(area.top, 0);
    const bottom = Math.min(area.bottom, win.innerHeight);
    if (area.width > 0 && area.height > 0 && end.width > 0 && end.height > 0
      && end.bottom > top && end.bottom <= bottom + 1
      && end.right > Math.max(area.left, 0) && end.left < Math.min(area.right, win.innerWidth)) {
      onVisible();
    }
  };
  const schedule = () => {
    if (frame === undefined) frame = win.requestAnimationFrame(check);
  };
  viewport.addEventListener('scroll', schedule);
  doc.addEventListener('visibilitychange', schedule);
  win.addEventListener('focus', schedule);
  win.addEventListener('resize', schedule);
  // Chromium visibility tracking also excludes messages obscured by dialogs or other surfaces.
  const options: IntersectionObserverInit & { trackVisibility: boolean; delay: number } = {
    root: viewport, trackVisibility: true, delay: 100,
  };
  const intersection = new IntersectionObserver((entries) => {
    visible = (entries[entries.length - 1] as IntersectionObserverEntry & { isVisible: boolean }).isVisible;
    schedule();
  }, options);
  intersection.observe(message);
  const resize = new ResizeObserver(schedule);
  resize.observe(viewport);
  resize.observe(message);
  schedule();
  return () => {
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    viewport.removeEventListener('scroll', schedule);
    doc.removeEventListener('visibilitychange', schedule);
    win.removeEventListener('focus', schedule);
    win.removeEventListener('resize', schedule);
    intersection.disconnect();
    resize.disconnect();
  };
}
