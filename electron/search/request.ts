import { domainToASCII } from 'node:url';
import { z } from 'zod';
import type { SearchCapabilities, SearchRequest, SearchSource } from '../../shared/types/web-search.js';

const hostname = z.string().trim().min(1).refine((value) => {
  if (/[/\\:@?#\s]/u.test(value)) return false;
  const ascii = domainToASCII(value);
  return ascii.length <= 253 && ascii.split('.').every((label) => (
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)
  ));
}, '请填写域名，不含协议、端口或路径。');

const dateError = '请按 YYYY-MM-DD 格式填写有效日期。';
const searchDate = z.string({ error: dateError }).pipe(z.iso.date({ error: dateError }));

const searchRequestShape = {
  query: z.string().trim().min(1).describe('搜索关键词或简短问题，应明确要查找的对象和主题。'),
  domains: z.strictObject({
    mode: z.enum(['include', 'exclude']).describe('include 仅搜索指定网站；exclude 排除指定网站。'),
    values: z.array(hostname).min(1).max(200).describe('域名列表，不含协议、端口或路径；匹配域名及其子域名。'),
  }).optional().describe('只搜索指定网站，或排除指定网站。'),
  publishedAfter: searchDate.optional()
    .describe('最早发布日期，格式为 YYYY-MM-DD，包含该日；按 UTC 和来源提供的发布日期筛选。'),
  publishedBefore: searchDate.optional()
    .describe('发布日期截止日期，格式为 YYYY-MM-DD，不包含该日；应晚于 publishedAfter，日期按 UTC 计算。'),
};

export function createSearchRequestSchema(capabilities: SearchCapabilities) {
  const schema = z.strictObject({
    query: searchRequestShape.query,
    ...(capabilities.domains ? { domains: searchRequestShape.domains } : {}),
    ...(capabilities.publishedAfter ? { publishedAfter: searchRequestShape.publishedAfter } : {}),
    ...(capabilities.publishedBefore ? { publishedBefore: searchRequestShape.publishedBefore } : {}),
  }) as z.ZodObject<typeof searchRequestShape>;
  return schema.refine((request) => (
    !request.publishedAfter || !request.publishedBefore || request.publishedAfter < request.publishedBefore
  ), { path: ['publishedBefore'], message: '截止日期必须晚于起始日期。' });
}

export const searchRequestSchema = createSearchRequestSchema({
  domains: true, publishedAfter: true, publishedBefore: true,
}) satisfies z.ZodType<SearchRequest>;

export function searchDomains(request: SearchRequest): string[] {
  return request.domains?.values.map((value) => domainToASCII(value).toLowerCase()) ?? [];
}

export function hasSearchFilters(request: SearchRequest): boolean {
  return Boolean(request.domains || request.publishedAfter || request.publishedBefore);
}

const publicationDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/** Apply the shared boundary semantics to the source metadata returned by providers. */
export function filterSearchSources(sources: readonly SearchSource[], request: SearchRequest): readonly SearchSource[] {
  const domains = searchDomains(request);
  const after = request.publishedAfter ? Date.parse(request.publishedAfter) : undefined;
  const before = request.publishedBefore ? Date.parse(request.publishedBefore) : undefined;
  return sources.filter((source) => {
    if (request.domains) {
      const host = new URL(source.url).hostname.toLowerCase().replace(/\.$/, '');
      const matches = domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
      if (request.domains.mode === 'include' ? !matches : matches) return false;
    }
    if (after !== undefined || before !== undefined) {
      const parsed = publicationDate.safeParse(source.publishedDate);
      if (!parsed.success) return false;
      const time = Date.parse(parsed.data);
      if (after !== undefined && time < after) return false;
      if (before !== undefined && time >= before) return false;
    }
    return true;
  });
}
