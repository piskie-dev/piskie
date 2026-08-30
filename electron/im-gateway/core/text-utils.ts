const WHITESPACE = /\s/u;

/** 渠道消息分片：优先在后半段的换行或空格处断开，否则按上限硬切。 */
export function chunkText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('Text chunk limit must be a positive safe integer');
  }
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let cursor = 0;

  while (text.length - cursor > limit) {
    const hardEnd = cursor + limit;
    const softStart = cursor + Math.ceil(limit / 2);
    let chunkEnd = findPreferredBreak(text, softStart, hardEnd) ?? hardEnd;

    // Keep CRLF outside the preceding chunk when the selected break is its newline.
    if (
      chunkEnd > cursor + 1
      && text.charCodeAt(chunkEnd - 1) === 13
      && text.charCodeAt(chunkEnd) === 10
    ) {
      chunkEnd -= 1;
    }

    chunks.push(text.slice(cursor, chunkEnd));
    cursor = skipWhitespace(text, chunkEnd);
  }

  if (cursor < text.length) chunks.push(text.slice(cursor));
  return chunks;
}

function findPreferredBreak(text: string, start: number, end: number): number | undefined {
  let latestSpace: number | undefined;
  for (let index = end; index >= start; index -= 1) {
    const code = text.charCodeAt(index);
    if (code === 10) return index;
    if (code === 32 && latestSpace === undefined) {
      latestSpace = index;
    }
  }
  return latestSpace;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && WHITESPACE.test(text[index])) index += 1;
  return index;
}
