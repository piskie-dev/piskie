export type ContentTargetKind = 'url' | 'path';

export interface ContentTarget {
  kind: ContentTargetKind;
  value: string;
  start: number;
  end: number;
}

const TRAILING_CHARACTERS = new Set([
  '.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"', '`',
  '、', '。', '，', '；', '：', '！', '？', '）', '】', '》', '〉', '」', '』', '”', '’',
]);
const CJK_PROSE_PUNCTUATION = new Set([
  '、', '。', '，', '；', '：', '！', '？', '（', '）', '【', '】', '《', '》', '〈', '〉',
  '「', '」', '『', '』', '“', '”', '‘', '’',
]);
const FILE_EXTENSION_RE = /\.(?=[A-Za-z0-9+_-]{1,16}$)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]+$/u;

function startsWithIgnoreCase(text: string, index: number, prefix: string): boolean {
  return text.slice(index, index + prefix.length).toLowerCase() === prefix;
}

function hasTokenBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[A-Za-z0-9_]/.test(text[index - 1] ?? '');
}

function urlEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (/[\s<>"'`\])]/.test(char) || CJK_PROSE_PUNCTUATION.has(char)) break;
    index += 1;
  }
  return index;
}

function isPathStop(char: string, offset: number, drivePath: boolean): boolean {
  return char === '\n'
    || char === '\r'
    || char === '\t'
    || char === '<'
    || char === '>'
    || char === '"'
    || char === "'"
    || char === '`'
    || char === '*'
    || char === '?'
    || char === '|'
    || char === ']'
    || (char === ':' && !(drivePath && offset === 1))
    || CJK_PROSE_PUNCTUATION.has(char);
}

function looksLikeTargetStart(text: string, index: number): boolean {
  if (!hasTokenBoundary(text, index)) return false;
  return startsWithIgnoreCase(text, index, 'https://')
    || startsWithIgnoreCase(text, index, 'http://')
    || isWindowsDrivePath(text, index)
    || isUncPath(text, index)
    || text[index] === '/';
}

function tokenEndsWithFileExtension(text: string, start: number, end: number): boolean {
  let candidateEnd = end;
  while (candidateEnd > start && TRAILING_CHARACTERS.has(text[candidateEnd - 1] ?? '')) {
    candidateEnd -= 1;
  }
  return FILE_EXTENSION_RE.test(text.slice(start, candidateEnd));
}

/** Find the first later space-delimited token that completes a filename such as `final image.png`. */
function fileContinuationEnd(
  text: string,
  index: number,
  pathStart: number,
  drivePath: boolean,
): number | null {
  let tokenStart = index;
  let cursor = index;

  while (cursor < text.length) {
    const char = text[cursor] ?? '';
    if (isPathStop(char, cursor - pathStart, drivePath)) {
      return tokenEndsWithFileExtension(text, tokenStart, cursor) ? cursor : null;
    }
    if (/[ \t\u00a0]/.test(char)) {
      if (tokenEndsWithFileExtension(text, tokenStart, cursor)) return cursor;
      let next = cursor;
      while (next < text.length && /[ \t\u00a0]/.test(text[next] ?? '')) next += 1;
      if (looksLikeTargetStart(text, next)) return null;
      tokenStart = next;
      cursor = next;
      continue;
    }
    cursor += 1;
  }

  return tokenEndsWithFileExtension(text, tokenStart, cursor) ? cursor : null;
}

function pathEnd(text: string, start: number, drivePath: boolean): number {
  let index = start;
  let allowedFileContinuationEnd = -1;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (isPathStop(char, index - start, drivePath)) break;

    if (/[ \t\u00a0]/.test(char)) {
      let next = index;
      while (next < text.length && /[ \t\u00a0]/.test(text[next] ?? '')) next += 1;
      const nextChar = text[next] ?? '';
      if (looksLikeTargetStart(text, next)) break;

      if (tokenEndsWithFileExtension(text, start, index)
        && index >= allowedFileContinuationEnd) {
        const continuationEnd = fileContinuationEnd(text, next, start, drivePath);
        if (continuationEnd === null) break;
        allowedFileContinuationEnd = continuationEnd;
      }

      if (/[\u3000-\u9fff\uf900-\ufeff\uff00-\uffef]/.test(nextChar)
        && index >= allowedFileContinuationEnd) {
        const continuationEnd = fileContinuationEnd(text, next, start, drivePath);
        if (continuationEnd === null) break;
        allowedFileContinuationEnd = continuationEnd;
      }
    }

    index += 1;
  }
  return index;
}

function trimTargetEnd(text: string, start: number, end: number): number {
  let nextEnd = end;
  while (nextEnd > start) {
    const char = text[nextEnd - 1] ?? '';
    if (!/\s/.test(char) && !TRAILING_CHARACTERS.has(char)) break;
    nextEnd -= 1;
  }
  return nextEnd;
}

function isWindowsDrivePath(text: string, index: number): boolean {
  return /[A-Za-z]/.test(text[index] ?? '')
    && text[index + 1] === ':'
    && (text[index + 2] === '\\' || text[index + 2] === '/');
}

function isUncPath(text: string, index: number): boolean {
  return text[index] === '\\' && text[index + 1] === '\\';
}

function isUnixPath(text: string, start: number, end: number): boolean {
  if (text[start] !== '/') return false;
  let segmentCount = 0;
  let hasSegmentText = false;

  for (let index = start + 1; index < end; index += 1) {
    if (text[index] === '/') {
      if (hasSegmentText) segmentCount += 1;
      hasSegmentText = false;
    } else if (!/\s/.test(text[index] ?? '')) {
      hasSegmentText = true;
    }
  }
  if (hasSegmentText) segmentCount += 1;
  return segmentCount >= 2;
}

function detectAt(text: string, index: number): ContentTarget | null {
  if (!hasTokenBoundary(text, index)) return null;

  const isUrl = startsWithIgnoreCase(text, index, 'https://')
    || startsWithIgnoreCase(text, index, 'http://');
  if (isUrl) {
    const end = trimTargetEnd(text, index, urlEnd(text, index));
    return end > index ? { kind: 'url', value: text.slice(index, end), start: index, end } : null;
  }

  const drivePath = isWindowsDrivePath(text, index);
  const uncPath = isUncPath(text, index);
  const unixCandidate = text[index] === '/';
  if (!drivePath && !uncPath && !unixCandidate) return null;

  let end = pathEnd(text, index, drivePath);
  end = trimTargetEnd(text, index, end);
  if (end <= index) return null;
  if (unixCandidate && !isUnixPath(text, index, end)) return null;

  return { kind: 'path', value: text.slice(index, end), start: index, end };
}

/** Finds every URL and absolute file path without imposing a text-length or match-count cap. */
export function scanContentTargets(text: string): ContentTarget[] {
  const targets: ContentTarget[] = [];
  let index = 0;

  while (index < text.length) {
    const target = detectAt(text, index);
    if (!target) {
      index += 1;
      continue;
    }
    targets.push(target);
    index = target.end;
  }

  return targets;
}

export function targetFromHref(href: string): Pick<ContentTarget, 'kind' | 'value'> | null {
  const value = href.trim();
  if (!value || value.startsWith('#')) return null;
  if (/^https?:\/\//i.test(value)) return { kind: 'url', value };
  if (/^file:\/\//i.test(value)) {
    try {
      const fileUrl = new URL(value);
      const decodedPath = decodeURIComponent(fileUrl.pathname);
      const hostPrefix = fileUrl.host ? `//${fileUrl.host}` : '';
      const platformPath = /^\/[A-Za-z]:\//.test(decodedPath) ? decodedPath.slice(1) : decodedPath;
      return { kind: 'path', value: `${hostPrefix}${platformPath}` };
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  return { kind: 'path', value };
}
