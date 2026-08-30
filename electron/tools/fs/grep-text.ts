import { CappedPage } from './_lib/cap.js';

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

/** Renders raw ripgrep lines without JSON serialization or protocol labels. */
export function renderGrepText(options: {
  mode: GrepOutputMode;
  lines: readonly string[];
  limit: number;
  hasMore: boolean;
  nextOffset: number;
}): CappedPage {
  const ordered = options.mode === 'content' ? [...options.lines] : [...options.lines].sort();
  const body = ordered.length > 0 ? ordered.join('\n') : 'No matches found';
  const more = options.hasMore
    ? `\n\n已显示 ${ordered.length} 条。继续搜索：设置 offset=${options.nextOffset}；`
      + '也可以收窄 pattern、glob 或 path。'
    : '';
  return new CappedPage({
    text: body + more,
    count: ordered.length,
    truncated: options.hasMore,
  });
}
