import { describe, expect, it } from 'vitest';

import type { InferenceModelDefinition } from '../../../../../shared/types/inference';
import type { ReasoningProfile } from '../../../../../shared/types/reasoning';
import {
  BLANK_COMFY,
  buildComfyBindings,
  comfyDraftOf,
  composeCatalogModel,
  equalCatalogShape,
  sealBinding,
  suggestOutputNodes,
  unsealBinding,
  wireIdOf,
} from '../model-forge-kit';

const NO_THINK: ReasoningProfile = { mode: 'none' } as ReasoningProfile;
const CONTEXT_REQUIRED = 'AI 模型必须填写上下文窗口';
const COMFY_MESSAGES = {
  workflowRequired: '请先上传 ComfyUI 工作流',
  promptMappingRequired: '请选择提示词映射',
  outputNodeRequired: '请选择至少一个输出节点',
};

function draft(overrides: Partial<Parameters<typeof composeCatalogModel>[0]['draft']> = {}) {
  return {
    displayName: ' 测试模型 ',
    contextWindow: 200_000,
    tools: 'supported' as const,
    vision: 'unknown' as const,
    streaming: 'unsupported' as const,
    imageGenerate: 'unknown' as const,
    imageEdit: 'unknown' as const,
    imageReferenceImages: 'unknown' as const,
    imageMask: 'unknown' as const,
    ...overrides,
  };
}

describe('composeCatalogModel', () => {
  it('AI:能力三态压实(unknown 不出现),思考随 profile,vision=true 才收图', () => {
    const model = composeCatalogModel({
      id: 'custom/p1/m1',
      gateway: 'ai',
      driver: 'openai',
      draft: draft(),
      reasoningProfile: NO_THINK,
      contextRequiredMessage: CONTEXT_REQUIRED,
    });
    expect(model.capabilities).toEqual({ tools: true, streaming: false, reasoning: false });
    expect(model.inputModalities).toEqual(['text']);
    expect(model.displayName).toBe('测试模型');
    expect(model.limits.contextWindow).toBe(200_000);
  });

  it('AI 缺上下文窗口直接抛错', () => {
    expect(() => composeCatalogModel({
      id: 'x',
      gateway: 'ai',
      driver: 'openai',
      draft: draft({ contextWindow: undefined }),
      reasoningProfile: NO_THINK,
      contextRequiredMessage: CONTEXT_REQUIRED,
    })).toThrow('上下文窗口');
  });

  it('Comfy:能力由 bindings 派生(有 inputImages→edit/referenceImages,有 mask→mask)', () => {
    const model = composeCatalogModel({
      id: 'custom/p1/wf',
      gateway: 'image',
      driver: 'comfyui-workflow',
      draft: draft(),
      comfyOptions: {
        workflowAssetId: 'a1',
        bindings: { inputImages: [{ nodeId: '3', field: 'image' }], mask: { nodeId: '4', field: 'mask' } },
      },
      reasoningProfile: NO_THINK,
      contextRequiredMessage: CONTEXT_REQUIRED,
    });
    expect(model.capabilities).toEqual({ generate: true, edit: true, referenceImages: true, mask: true });
    expect(model.inputModalities).toEqual(['text', 'image']);
    expect(model.outputModalities).toEqual(['image']);
  });

  it('沿用既有定义的 family/releaseDate/pricing 并合并 compatibleDrivers', () => {
    const existing = {
      family: 'openai',
      releaseDate: '2026-01-01',
      compatibleDrivers: ['anthropic-messages'],
      capabilities: {},
      source: { kind: 'remote' },
      lifecycle: 'active',
      pricing: { inputPerMTok: 1 },
    } as unknown as InferenceModelDefinition;
    const model = composeCatalogModel({
      id: 'openai/gpt-x',
      gateway: 'ai',
      driver: 'openai',
      draft: draft(),
      existing,
      reasoningProfile: NO_THINK,
      contextRequiredMessage: CONTEXT_REQUIRED,
    });
    expect(model.family).toBe('openai');
    expect(model.releaseDate).toBe('2026-01-01');
    expect(model.compatibleDrivers.sort()).toEqual(['anthropic-messages', 'openai']);
    expect(model.pricing).toEqual({ inputPerMTok: 1 });
  });
});

describe('equalCatalogShape', () => {
  it('忽略 source/operationCapability,键序无关', () => {
    const model = composeCatalogModel({
      id: 'openai/gpt-x',
      gateway: 'ai',
      driver: 'openai',
      draft: draft(),
      reasoningProfile: NO_THINK,
      contextRequiredMessage: CONTEXT_REQUIRED,
    });
    const definition = {
      ...JSON.parse(JSON.stringify(model)),
      source: { kind: 'remote', updatedAt: '2026-08-01' },
      operationCapability: { anything: true },
    } as unknown as InferenceModelDefinition;
    expect(equalCatalogShape(definition, model)).toBe(true);
  });
});

describe('wireIdOf', () => {
  it('剥 family 前缀;无前缀原样', () => {
    expect(wireIdOf({ id: 'openai/gpt-x', family: 'openai' } as InferenceModelDefinition)).toBe('gpt-x');
    expect(wireIdOf({ id: 'solo-model' } as InferenceModelDefinition)).toBe('solo-model');
  });
});

describe('Comfy 封解与草稿', () => {
  it('seal/unseal 往返;非法值 unseal 为 undefined', () => {
    expect(unsealBinding(sealBinding({ nodeId: '6', field: 'text' }))).toEqual({ nodeId: '6', field: 'text' });
    expect(unsealBinding('无分隔符')).toBeUndefined();
  });

  it('comfyDraftOf 还原字段并保留未展示 bindings;无资产回 BLANK', () => {
    const restored = comfyDraftOf({
      catalogId: 'c',
      upstreamId: 'u',
      enabled: true,
      options: {
        workflowAssetId: 'a1',
        bindings: { prompt: { nodeId: '6', field: 'text' }, extra: { nodeId: '9', field: 'x' } },
        outputNodeIds: ['9'],
      },
    });
    expect(restored.assetId).toBe('a1');
    expect(restored.prompt).toBe('6::text');
    expect(restored.outputNodeIds).toEqual(['9']);
    expect(restored.preservedBindings.extra).toEqual({ nodeId: '9', field: 'x' });
    expect(comfyDraftOf(undefined)).toEqual(BLANK_COMFY);
  });

  it('buildComfyBindings:提示词/输出节点必选;候选兜底 inputImages/mask;保留未展示键', () => {
    const complete = buildComfyBindings(
      {
        ...BLANK_COMFY,
        assetId: 'a1',
        prompt: '6::text',
        outputNodeIds: ['9'],
        preservedBindings: { extra: 1 },
      },
      { inputImages: [{ nodeId: '3', field: 'image' }], mask: [] },
      COMFY_MESSAGES,
    );
    expect(complete.bindings.prompt).toEqual({ nodeId: '6', field: 'text' });
    expect(complete.bindings.inputImages).toEqual([{ nodeId: '3', field: 'image' }]);
    expect(complete.bindings.extra).toBe(1);

    expect(() => buildComfyBindings(
      { ...BLANK_COMFY, assetId: 'a1', outputNodeIds: ['9'] },
      undefined,
      COMFY_MESSAGES,
    ))
      .toThrow('提示词');
    expect(() => buildComfyBindings(
      { ...BLANK_COMFY, assetId: 'a1', prompt: '6::text' },
      undefined,
      COMFY_MESSAGES,
    ))
      .toThrow('输出节点');
  });

  it('suggestOutputNodes:save/preview 优先,否则末节点', () => {
    expect(suggestOutputNodes({
      nodes: [
        { nodeId: '1', classType: 'KSampler' },
        { nodeId: '2', classType: 'SaveImage', title: '保存' },
      ],
    } as Parameters<typeof suggestOutputNodes>[0])).toEqual(['2']);
    expect(suggestOutputNodes({
      nodes: [{ nodeId: '1', classType: 'KSampler' }, { nodeId: '2', classType: 'VAEDecode' }],
    } as Parameters<typeof suggestOutputNodes>[0])).toEqual(['2']);
  });
});
