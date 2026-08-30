import { describe, expect, it } from 'vitest';
// The catalog synchronizer is an ESM build script rather than application TypeScript.
// @ts-expect-error Build scripts intentionally do not publish TypeScript declarations.
import { parseAliyunImageModels, parseBaiduImageModels, parseZhipuImageModels } from '../../../scripts/model-catalog/image-catalog-sources.mjs';

describe('official image catalog sources', () => {
  it('parses Aliyun capability columns without duplicating the recommended table', () => {
    const models = parseAliyunImageModels(`
      <table><tbody><tr><td><code>recommended-only</code></td></tr></tbody></table>
      ## 所有模型
      <table><tbody>
        <tr><td><code>wan2.7-image</code></td><td>支持</td><td>支持</td><td>4（连续12）</td><td>2048x2048</td></tr>
        <tr><td><b>Legacy</b></td></tr>
        <tr><td><code>wanx-v1</code></td><td>支持</td><td>不支持</td><td>1</td><td>1024x1024</td></tr>
      </tbody></table>
    `);

    expect(models.map((model: { id: string }) => model.id)).toEqual(['wan2.7-image', 'wanx-v1']);
    expect(models[0]).toMatchObject({
      inputModalities: ['text', 'image'],
      capabilityProfile: { generate: 'supported', edit: 'supported' },
      limits: { maxImages: 4 },
    });
    expect(models[1]).toMatchObject({ lifecycle: 'deprecated' });
  });

  it('parses Baidu generation and editing sections as separate capabilities', () => {
    const models = parseBaiduImageModels(`
      <h3>图像生成</h3><table><tbody>
        <tr><td>MuseSteamer Air Image</td><td>MuseSteamer-Air-Image</td><td>musesteamer-air-image</td></tr>
      </tbody></table>
      <h3>图像编辑</h3><table><tbody>
        <tr><td>Qwen Image Edit</td><td>Qwen-Image-Edit</td><td>qwen-image-edit</td></tr>
      </tbody></table>
    `);

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'musesteamer-air-image',
        capabilityProfile: expect.objectContaining({ generate: 'supported', edit: 'unsupported' }),
      }),
      expect.objectContaining({
        id: 'qwen-image-edit',
        inputModalities: ['text', 'image'],
        capabilityProfile: expect.objectContaining({ generate: 'unsupported', edit: 'supported' }),
      }),
    ]));
  });

  it('uses the Zhipu OpenAPI model enum instead of static ids', () => {
    const models = parseZhipuImageModels(`
      # Image API
      \`\`\`\`yaml /openapi/openapi.json post /paas/v4/images/generations
      components:
        schemas:
          CreateImageRequest:
            properties:
              model:
                enum:
                  - glm-image
                  - cogview-4-250304
      \`\`\`\`
    `);

    expect(models.map((model: { id: string }) => model.id)).toEqual(['cogview-4-250304', 'glm-image']);
    expect(models[0].releaseDate).toBe('2025-03-04');
  });

  it('rejects an empty or structurally changed source', () => {
    expect(() => parseAliyunImageModels('# no catalog')).toThrow(/all-models section/);
    expect(() => parseBaiduImageModels('<h3>图像生成</h3>')).toThrow(/图像生成 table/);
    expect(() => parseZhipuImageModels('# no OpenAPI')).toThrow(/OpenAPI/);
  });
});
