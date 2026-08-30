/**
 * tool_search — 统一能力搜索：搜模型看不见的能力。
 * ① 清单外技能（互斥基准 = 注入时刻快照的 manifest，ctx.skillInventory）；
 * ② deferred MCP 工具（超预算未直注的，命中即装载 schema——mcp 域接通，接入前 select:/关键词命中均为空集）。
 */

import { BaseTool } from '../base-tool.js';
import { z } from '../params.js';
import type { ToolContext, ToolDef, ToolOutput } from '../types.js';
import {
  searchSkills,
  visibleSkillNames,
  type SkillSearchHit,
  type SkillSearchSource,
} from '../../skills/discovery/search.js';

const MAX_RESULTS = 10;
const MAX_DEFERRED_LOAD = 5;
const DESCRIPTION_LIMIT = 256;

const toolSearchSchema = z.object({
  query: z.string().trim().min(1).describe(
    'Keywords describing the capability you need, or "select:<name>[,<name>]" to load specific deferred tools by exact name',
  ),
});
type ToolSearchParams = z.infer<typeof toolSearchSchema>;

type McpToolSearchHit = Readonly<{
  kind: 'mcp-tool';
  name: string;
  server: string;
  description: string;
  loaded: true;
}>;

type ToolSearchData = Readonly<{
  count: number;
  results: readonly (SkillSearchHit | McpToolSearchHit)[];
  hint?: string;
  loadedTools?: readonly string[];
}>;

const DESCRIPTION = 'Search capabilities you cannot see yet: installed skills absent from the '
  + '<available_skills> list, and deferred MCP tools (listed by name only in your context). '
  + 'Skill results: activate with load_skill. Deferred MCP results: this call loads their schemas '
  + 'into your tool set — call them directly afterwards. Use "select:<name>" to load specific '
  + 'deferred tools by exact name. Results never duplicate what is already visible to you.';

const ZERO_HIT_HINT = 'No installed capability matches. You may search remote skill sources via '
  + 'shell: piskie skill search "<query>" --remote --json';

export class ToolSearchTool extends BaseTool<ToolSearchParams, ToolSearchData> {
  constructor(private readonly source?: SkillSearchSource) {
    super();
  }

  readonly def: ToolDef<ToolSearchParams> = {
    name: 'tool_search',
    description: DESCRIPTION,
    schema: toolSearchSchema,
    scope: 'shared',
    effects: [],
  };

  async execute(
    params: ToolSearchParams,
    ctx: ToolContext,
  ): Promise<ToolOutput<ToolSearchData>> {
    const query = params.query.trim();

    if (query.toLowerCase().startsWith('select:')) {
      return this.loadByName(query.slice('select:'.length), ctx);
    }

    try {
      const skills = this.source
        ? await this.source.listSearchableSkills(ctx.runConfig.workspace)
        : [];
      const skillHits = searchSkills(skills, query, {
        exclude: visibleSkillNames(ctx.skillInventory),
      });
      const deferredHits = this.searchDeferred(query, ctx);

      if (skillHits.length === 0 && deferredHits.length === 0) {
        return this.success(ZERO_HIT_HINT, { count: 0, results: [], hint: ZERO_HIT_HINT });
      }

      let loadedTools: string[] | undefined;
      let mcpResults: McpToolSearchHit[] = [];
      if (deferredHits.length > 0 && ctx.deferredTools) {
        const names = deferredHits.map((tool) => tool.modelName);
        loadedTools = ctx.deferredTools.load(names).loaded;
        mcpResults = deferredHits
          .filter((tool) => loadedTools?.includes(tool.modelName))
          .map((tool) => ({
            kind: 'mcp-tool' as const,
            name: tool.modelName,
            server: tool.server,
            description: truncate(tool.description, DESCRIPTION_LIMIT),
            loaded: true as const,
          }));
      }

      // MCP 命中带装载副作用，先保留；总输出仍严格不超过 10 条。
      const selectedSkillHits = skillHits.slice(0, MAX_RESULTS - mcpResults.length);
      const results: Array<SkillSearchHit | McpToolSearchHit> = [
        ...mcpResults,
        ...selectedSkillHits,
      ];
      const lines: string[] = [];
      if (mcpResults.length > 0) {
        lines.push('Matching MCP tools (schemas now loaded — call them directly):');
        for (const tool of mcpResults) {
          lines.push(`- ${tool.name}: ${tool.description || '(no description)'}`);
        }
      }
      if (selectedSkillHits.length > 0) {
        if (lines.length > 0) lines.push('');
        for (const hit of selectedSkillHits) {
          const fns = hit.functions.length > 0 ? ` [functions: ${hit.functions.join(',')}]` : '';
          const desc = hit.description || '(no description)';
          lines.push(`- ${hit.name} (${hit.scope}): ${desc} (file: ${hit.path})${fns}`);
        }
        lines.push('', 'Activate a skill with load_skill before use.');
      }

      return this.success(lines.join('\n'), {
        count: results.length,
        results,
        loadedTools,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`Failed to search capabilities: ${message}`);
    }
  }

  /** select:<name>[,<name>] —— 按精确名装载 deferred MCP 工具 */
  private loadByName(rawNames: string, ctx: ToolContext): ToolOutput<ToolSearchData> {
    const names = rawNames.split(',').map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) {
      return this.error('select: requires at least one tool name, e.g. "select:mcp__server__tool"');
    }
    if (names.length > MAX_DEFERRED_LOAD) {
      return this.error(`select: loads at most ${MAX_DEFERRED_LOAD} deferred tools per call`);
    }
    if (!ctx.deferredTools) {
      return this.success(
        'No deferred tools are registered in this session, so there is nothing to load by name. '
        + 'Use keyword search for installed skills instead.',
        { count: 0, results: [] },
      );
    }
    const available = new Map(ctx.deferredTools.list().map((tool) => [tool.modelName, tool]));
    const { loaded, unknown } = ctx.deferredTools.load(names);
    const lines: string[] = [];
    if (loaded.length > 0) {
      lines.push(`Loaded ${loaded.length} tool(s) — schemas are now in your tool set, call them directly:`);
      for (const name of loaded) lines.push(`- ${name}`);
    }
    if (unknown.length > 0) {
      const available = ctx.deferredTools.list().map((tool) => tool.modelName);
      lines.push(
        `Unknown deferred tool name(s): ${unknown.join(', ')}.`,
        available.length > 0
          ? `Available deferred tools: ${available.join(', ')}`
          : 'No deferred tools are registered in this session.',
      );
    }
    const results: McpToolSearchHit[] = loaded.map((name) => {
      const tool = available.get(name);
      return {
        kind: 'mcp-tool',
        name,
        server: tool?.server ?? '',
        description: truncate(tool?.description ?? '', DESCRIPTION_LIMIT),
        loaded: true,
      };
    });
    return loaded.length > 0
      ? this.success(lines.join('\n'), { count: loaded.length, results, loadedTools: loaded })
      : this.error(lines.join('\n'));
  }

  /** 关键词匹配 deferred MCP 工具（名字 + 描述子串，全部词都命中才算） */
  private searchDeferred(
    query: string,
    ctx: ToolContext,
  ): readonly { modelName: string; server: string; description: string }[] {
    if (!ctx.deferredTools) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const scored = ctx.deferredTools.list().map((tool) => {
      const name = tool.modelName.toLowerCase();
      const server = tool.server.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        let termScore = 0;
        if (name === term) termScore = 200;
        else if (name.includes(term)) termScore = 100;
        else if (server.includes(term)) termScore = 60;
        else if (description.includes(term)) termScore = 30;
        if (termScore > 0) {
          score += termScore;
          matchedTerms += 1;
        }
      }
      return { tool, score, matchedTerms };
    }).filter((item) => item.score > 0);
    const allTerms = scored.filter((item) => item.matchedTerms === terms.length);
    return (allTerms.length > 0 ? allTerms : scored)
      .sort((a, b) => b.score - a.score || a.tool.modelName.localeCompare(b.tool.modelName))
      .slice(0, MAX_DEFERRED_LOAD)
      .map((item) => item.tool);
  }
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
