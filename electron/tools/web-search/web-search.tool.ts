import { BASIC_SEARCH_CAPABILITIES, type SearchDiagnostics, type SearchFailure } from '../../../shared/types/web-search.js';
import { SearchError } from '../../search/contracts.js';
import { searchError } from '../../search/errors.js';
import { formatSearchDocument } from '../../search/format-result.js';
import { searchRequestSchema } from '../../search/request.js';
import { BaseTool } from '../base-tool.js';
import { z } from '../params.js';
import type { ToolContext, ToolDef } from '../types.js';

export class WebSearchTool extends BaseTool<z.infer<typeof searchRequestSchema>, SearchDiagnostics | SearchFailure> {
  readonly def: ToolDef<z.infer<typeof searchRequestSchema>> = {
    name: 'web_search', scope: 'shared', effects: ['external'], schema: searchRequestSchema,
    description: '搜索公开网页并返回相关摘录和来源链接。需要最新信息、事实核实或资料检索时使用。',
    modelInputSchema: (schema, { searchCapabilities = BASIC_SEARCH_CAPABILITIES }) => ({
      ...schema,
      properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => (
        name === 'query' || searchCapabilities[name as keyof typeof searchCapabilities]
      ))),
    }),
  };

  async execute(params: z.infer<typeof searchRequestSchema>, context: ToolContext) {
    try {
      context.signal.throwIfAborted();
      if (!context.search) throw searchError('not_configured');
      const result = await context.search.search(params, {
        signal: context.signal, sessionId: `conversation:${context.mainAgentId}`,
      });
      return this.success(formatSearchDocument(result.document), result.diagnostics);
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof SearchError) return this.error(error.message, error.failure);
      throw error;
    }
  }
}
