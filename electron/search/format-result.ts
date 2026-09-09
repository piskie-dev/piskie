import type { SearchDocument } from '../../shared/types/web-search.js';

export function formatSearchDocument(document: SearchDocument): string {
  const evidence = document.evidence;
  const text = evidence.kind === 'text'
    ? evidence.text
    : evidence.sources.map((source, index) => [
      `[${index + 1}] ${source.title || source.url}`,
      source.url,
      ...(source.publishedDate ? [`Published: ${source.publishedDate}`] : []),
      ...source.excerpts,
    ].join('\n')).join('\n\n') || '未找到相关网页。';
  return [text, ...(document.notices ?? [])].join('\n\n');
}
