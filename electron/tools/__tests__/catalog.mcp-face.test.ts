import { describe, expect, it } from 'vitest';
import {
  createDeferredToolsPort,
  ToolCatalog,
  type CatalogEntry,
  type FinalToolFace,
} from '../catalog.js';
import { z } from '../params.js';
import type { ITool, ToolInputSchema } from '../types.js';

function nativeTool(name: string): ITool {
  return {
    def: {
      name,
      description: `${name} description`,
      schema: z.object({}),
      scope: 'shared',
      effects: [],
    },
    async execute() {
      return { ok: true, text: name };
    },
  };
}

function mcpEntry(
  visibleName: string,
  rawTool: string,
  exposure: 'direct' | 'deferred',
): CatalogEntry {
  const schema: ToolInputSchema = { type: 'object', properties: {} };
  return Object.freeze({
    modelName: visibleName,
    tool: {
      def: {
        name: visibleName,
        description: `${rawTool} via mcp`,
        schema: z.looseObject({}),
        scope: 'shared' as const,
        effects: [],
      },
      async execute() {
        return { ok: true as const, text: rawTool };
      },
    },
    trust: 'custom' as const,
    identity: {
      kind: 'mcp' as const,
      server: 'srv',
      tool: rawTool,
      transport: 'stdio' as const,
      origin: 'global-explicit' as const,
    },
    exposure,
    definitionOverride: {
      name: visibleName,
      description: `${rawTool} via mcp`,
      input_schema: schema,
    },
  });
}

function baseFace(): FinalToolFace {
  return {
    scope: 'main',
    agentType: 'main',
    customTools: ['native_tool'],
    exposedSkillFunctions: [],
    excluded: new Set(),
    domains: new Set(['local']),
  };
}

describe('Catalog projection entries', () => {
  it('direct 条目直接进 definitions，定义用 definitionOverride 原样 schema', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('native_tool'), 'builtin');
    const snapshot = catalog.snapshot(baseFace(), {
      entries: [mcpEntry('mcp__srv__alpha', 'alpha', 'direct')],
    });

    const definitions = snapshot.definitions();
    expect(definitions.map((definition) => definition.name)).toEqual(['native_tool', 'mcp__srv__alpha']);
    expect(definitions[1].description).toBe('alpha via mcp');
    expect(snapshot.resolve('mcp__srv__alpha')?.identity?.kind).toBe('mcp');
  });

  it('deferred 条目不进默认 definitions，装载后追加出现', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('native_tool'), 'builtin');
    const snapshot = catalog.snapshot(baseFace(), {
      entries: [mcpEntry('mcp__srv__beta', 'beta', 'deferred')],
    });

    expect(snapshot.definitions().map((definition) => definition.name)).toEqual(['native_tool']);
    expect(snapshot.resolve('mcp__srv__beta')).toBeUndefined();
    expect(snapshot.resolveDeferred('mcp__srv__beta')?.modelName).toBe('mcp__srv__beta');

    const loaded = snapshot.definitions(new Set(['mcp__srv__beta']));
    expect(loaded.map((definition) => definition.name)).toEqual(['native_tool', 'mcp__srv__beta']);
  });

  it('deferredTools() 列出名字行素材', () => {
    const catalog = new ToolCatalog();
    const snapshot = catalog.snapshot(baseFace(), { entries: [
      mcpEntry('mcp__srv__a', 'a', 'deferred'),
      mcpEntry('mcp__srv__b', 'b', 'direct'),
    ] });
    expect(snapshot.deferredTools()).toEqual([
      { modelName: 'mcp__srv__a', server: 'srv', description: 'a via mcp' },
    ]);
  });

  it('deferred port 装载后立即迁出搜索覆盖集，重复装载不会改变投影', () => {
    const catalog = new ToolCatalog();
    const snapshot = catalog.snapshot(baseFace(), { entries: [
      mcpEntry('mcp__srv__a', 'a', 'deferred'),
      mcpEntry('mcp__srv__b', 'b', 'deferred'),
    ] });
    const loaded = new Set<string>();
    const port = createDeferredToolsPort(() => snapshot, loaded);

    expect(port.list().map((tool) => tool.modelName)).toEqual(['mcp__srv__a', 'mcp__srv__b']);
    expect(port.load(['mcp__srv__a', 'mcp__srv__a'])).toEqual({
      loaded: ['mcp__srv__a'],
      unknown: [],
    });
    expect(port.list().map((tool) => tool.modelName)).toEqual(['mcp__srv__b']);
    expect(port.load(['mcp__srv__a'])).toEqual({ loaded: [], unknown: ['mcp__srv__a'] });
    expect(snapshot.definitions(loaded).map((definition) => definition.name)).toEqual([
      'mcp__srv__a',
    ]);
  });

  it('同一成功装载历史重放得到逐步完全一致的追加式投影', () => {
    const catalog = new ToolCatalog();
    const snapshot = catalog.snapshot(baseFace(), { entries: [
      mcpEntry('mcp__srv__a', 'a', 'deferred'),
      mcpEntry('mcp__srv__b', 'b', 'deferred'),
      mcpEntry('mcp__srv__c', 'c', 'deferred'),
    ] });
    const replay = (batches: string[][]) => {
      const loaded = new Set<string>();
      const port = createDeferredToolsPort(() => snapshot, loaded);
      const projections = [snapshot.definitions(loaded).map((tool) => tool.name)];
      for (const batch of batches) {
        port.load(batch);
        projections.push(snapshot.definitions(loaded).map((tool) => tool.name));
      }
      return projections;
    };
    const history = [['mcp__srv__b', 'mcp__srv__a'], ['mcp__srv__c']];

    expect(replay(history)).toEqual(replay(history));
    expect(replay(history)).toEqual([
      [],
      ['mcp__srv__a', 'mcp__srv__b'],
      ['mcp__srv__a', 'mcp__srv__b', 'mcp__srv__c'],
    ]);
  });

  it('一次成功批量装载只改变一次 tools 前缀，重复/失败装载不改变；新运行装载集清零', () => {
    const catalog = new ToolCatalog();
    const snapshot = catalog.snapshot(baseFace(), { entries: [
      mcpEntry('mcp__srv__a', 'a', 'deferred'),
      mcpEntry('mcp__srv__b', 'b', 'deferred'),
    ] });
    const loaded = new Set<string>();
    const port = createDeferredToolsPort(() => snapshot, loaded);
    const signature = () => JSON.stringify(snapshot.definitions(loaded));
    const prefixes = [signature()];

    expect(port.load(['mcp__srv__a', 'mcp__srv__b']).loaded).toEqual([
      'mcp__srv__a',
      'mcp__srv__b',
    ]);
    prefixes.push(signature());
    expect(port.load(['mcp__srv__a', 'missing']).loaded).toEqual([]);
    prefixes.push(signature());

    const changes = prefixes.slice(1)
      .filter((prefix, index) => prefix !== prefixes[index]);
    expect(changes).toHaveLength(1);

    // Resume 创建新 Runtime，也就创建新 Set；历史 tool_search 只是事实记录，不恢复装载态。
    const resumedLoaded = new Set<string>();
    expect(snapshot.definitions(resumedLoaded)).toEqual([]);
    expect(createDeferredToolsPort(() => snapshot, resumedLoaded).list()).toHaveLength(2);
  });

  it('excluded 同样作用于 MCP 条目', () => {
    const catalog = new ToolCatalog();
    const face: FinalToolFace = {
      ...baseFace(),
      excluded: new Set(['mcp__srv__x']),
    };
    const snapshot = catalog.snapshot(face, {
      entries: [mcpEntry('mcp__srv__x', 'x', 'direct')],
    });
    expect(snapshot.resolve('mcp__srv__x')).toBeUndefined();
    expect(snapshot.deferredTools()).toEqual([]);
  });

  it('projection 与基础目录同名时显式拒绝，不静默覆盖执行闭包', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('mcp__srv__alpha'), 'builtin');

    expect(() => catalog.snapshot(baseFace(), {
      entries: [mcpEntry('mcp__srv__alpha', 'alpha', 'direct')],
    })).toThrow('Catalog projection modelName conflict: mcp__srv__alpha');
  });

  it('无 projection entries 时行为与旧目录完全一致', () => {
    const catalog = new ToolCatalog();
    catalog.register(nativeTool('native_tool'), 'builtin');
    const face: FinalToolFace = {
      scope: 'main',
      agentType: 'main',
      customTools: ['native_tool'],
      exposedSkillFunctions: [],
      excluded: new Set(),
      domains: new Set(['local']),
    };
    const snapshot = catalog.snapshot(face);
    expect(snapshot.definitions().map((definition) => definition.name)).toEqual(['native_tool']);
    expect(snapshot.deferredTools()).toEqual([]);
  });
});
