export interface TextareaVisualLine {
  readonly first: boolean;
  readonly last: boolean;
}

const TEXT_LAYOUT_PROPERTIES = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'font-kerning',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'text-align-last',
  'text-rendering',
  'direction',
  'tab-size',
  'white-space',
  'white-space-collapse',
  'text-wrap-mode',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'writing-mode',
] as const;

function logicalLineFallback(value: string, position: number): TextareaVisualLine {
  return {
    first: !value.slice(0, position).includes('\n'),
    last: !value.slice(position).includes('\n'),
  };
}

/** Measures the caret against the textarea's rendered lines without changing text wrapping. */
export function textareaVisualLine(textarea: HTMLTextAreaElement): TextareaVisualLine {
  const value = textarea.value;
  const position = textarea.selectionStart;
  const fallback = logicalLineFallback(value, position);
  const document = textarea.ownerDocument;
  const view = document.defaultView;
  const parent = document.body ?? document.documentElement;
  if (!view || !parent || textarea.clientWidth === 0) return fallback;

  const computed = view.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  for (const property of TEXT_LAYOUT_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: 'fixed',
    inset: '0 auto auto -100000px',
    boxSizing: 'border-box',
    width: `${textarea.clientWidth}px`,
    height: 'auto',
    minHeight: '0',
    maxHeight: 'none',
    margin: '0',
    border: '0',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
  });

  // One text node preserves shaping and emergency wrapping. The sentinels make
  // empty text and leading or trailing newlines measurable.
  const text = document.createTextNode(`\u2060${value}\u2060`);
  mirror.append(text);
  parent.append(mirror);

  try {
    const mirrorTop = mirror.getBoundingClientRect().top;
    const topAt = (offset: number): number | undefined => {
      const range = document.createRange();
      range.setStart(text, offset + 1);
      range.collapse(true);
      if (typeof range.getClientRects !== 'function') return undefined;
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects.item(rects.length - 1) : range.getBoundingClientRect();
      return rect && Number.isFinite(rect.top) ? rect.top - mirrorTop : undefined;
    };

    const startTop = topAt(0);
    const caretTop = topAt(position);
    const endTop = topAt(value.length);
    if (startTop === undefined || caretTop === undefined || endTop === undefined) return fallback;

    const fontSize = Number.parseFloat(computed.fontSize);
    const parsedLineHeight = Number.parseFloat(computed.lineHeight);
    const lineHeight = Number.isFinite(parsedLineHeight)
      ? parsedLineHeight
      : (Number.isFinite(fontSize) ? fontSize * 1.2 : 16);
    const tolerance = Math.max(0.5, lineHeight / 2);
    return {
      first: Math.abs(caretTop - startTop) < tolerance,
      last: Math.abs(caretTop - endTop) < tolerance,
    };
  } finally {
    mirror.remove();
  }
}
