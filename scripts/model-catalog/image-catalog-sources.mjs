import { load } from 'cheerio';
import yaml from 'js-yaml';

export const OFFICIAL_IMAGE_CATALOG_SOURCES = [
  {
    provider: 'aliyun',
    id: 'aliyun-docs',
    url: 'https://help.aliyun.com/zh/model-studio/image-model.md',
    parse: parseAliyunImageModels,
  },
  {
    provider: 'baidu',
    id: 'baidu-docs',
    url: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
    parse: parseBaiduImageModels,
  },
  {
    provider: 'zhipu',
    id: 'zhipu-docs',
    url: 'https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%9B%BE%E5%83%8F%E7%94%9F%E6%88%90.md',
    parse: parseZhipuImageModels,
  },
];

export function parseAliyunImageModels(markdown) {
  const allModelsIndex = markdown.indexOf('## 所有模型');
  if (allModelsIndex < 0) throw new Error('Aliyun image catalog is missing the all-models section');

  const $ = load(markdown.slice(allModelsIndex));
  const models = [];
  $('table').each((_, table) => {
    let lifecycle = 'active';
    $(table).find('tbody tr').each((__, row) => {
      const cells = $(row).find('td').toArray();
      const id = cells[0] ? $(cells[0]).find('code').first().text().trim() : '';
      if (!id) {
        if ($(row).text().includes('Legacy')) lifecycle = 'deprecated';
        return;
      }
      if (cells.length < 5) throw new Error(`Aliyun image catalog row is incomplete: ${id}`);

      const generate = capabilityState($(cells[1]).text());
      const edit = capabilityState($(cells[2]).text());
      const maxImages = firstPositiveInteger($(cells[3]).text());
      models.push(createImageModel({
        id,
        name: formatModelName(id),
        lifecycle: id.includes('preview') ? 'preview' : lifecycle,
        releaseDate: releaseDateFromId(id),
        generate,
        edit,
        maxImages,
      }));
    });
  });
  return uniqueModels(models, 'Aliyun');
}

export function parseBaiduImageModels(html) {
  const $ = load(html);
  const byId = new Map();
  for (const section of [
    { heading: '图像生成', capability: 'generate' },
    { heading: '图像编辑', capability: 'edit' },
  ]) {
    const heading = $('h3').filter((_, element) => $(element).text().trim() === section.heading).first();
    if (heading.length === 0) throw new Error(`Baidu image catalog is missing the ${section.heading} section`);
    const table = heading.nextAll('table').first();
    if (table.length === 0) throw new Error(`Baidu image catalog is missing the ${section.heading} table`);

    table.find('tbody tr').each((_, row) => {
      const cells = $(row).find('td').toArray();
      const id = cells[2] ? $(cells[2]).text().trim() : '';
      const name = cells[0] ? $(cells[0]).text().trim() : '';
      if (!id || !name) return;
      const current = byId.get(id) ?? {
        id,
        name,
        generate: 'unsupported',
        edit: 'unsupported',
      };
      current[section.capability] = 'supported';
      byId.set(id, current);
    });
  }

  return uniqueModels(
    [...byId.values()].map((model) => createImageModel(model)),
    'Baidu',
  );
}

export function parseZhipuImageModels(markdown) {
  const openApiBlock = markdown.match(/`{4}yaml[^\n]*\n([\s\S]*?)\n[ \t]*`{4}/);
  if (!openApiBlock?.[1]) throw new Error('Zhipu image catalog is missing its OpenAPI document');
  const openApi = yaml.load(openApiBlock[1]);
  const modelIds = openApi?.components?.schemas?.CreateImageRequest?.properties?.model?.enum;
  if (!Array.isArray(modelIds)) throw new Error('Zhipu image catalog is missing its model enum');

  return uniqueModels(modelIds.map((id) => createImageModel({
    id,
    name: formatModelName(id),
    releaseDate: releaseDateFromId(id),
    generate: 'supported',
    edit: 'unsupported',
    maxImages: 1,
  })), 'Zhipu');
}

function capabilityState(text) {
  const normalized = text.replaceAll(/\s/g, '');
  if (normalized.includes('不支持')) return 'unsupported';
  if (normalized.includes('支持')) return 'supported';
  return 'unknown';
}

function createImageModel({
  id,
  name,
  lifecycle = 'active',
  releaseDate,
  generate,
  edit,
  maxImages,
}) {
  const acceptsImages = edit === 'supported';
  return {
    id,
    name,
    kind: 'image',
    lifecycle,
    ...(releaseDate && { releaseDate }),
    inputModalities: acceptsImages ? ['text', 'image'] : ['text'],
    outputModalities: ['image'],
    capabilityProfile: {
      generate,
      edit,
      referenceImages: acceptsImages ? 'supported' : edit,
      mask: 'unknown',
    },
    ...(maxImages && { limits: { maxImages } }),
  };
}

function firstPositiveInteger(value) {
  const parsed = Number.parseInt(value.match(/\d+/)?.[0] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function releaseDateFromId(id) {
  const iso = id.match(/(?:^|[-_])(20\d{2})-(\d{2})-(\d{2})(?:$|[-_])/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = id.match(/(?:^|[-_])(\d{2})(\d{2})(\d{2})(?:$|[-_])/);
  if (compact) return `20${compact[1]}-${compact[2]}-${compact[3]}`;
  return undefined;
}

function formatModelName(id) {
  return id
    .split(/[-_/]+/)
    .map((part) => {
      if (/^glm$/i.test(part)) return 'GLM';
      if (/^qwen$/i.test(part)) return 'Qwen';
      if (/^cogview$/i.test(part)) return 'CogView';
      if (/^wanx?$/i.test(part)) return part.toLowerCase() === 'wanx' ? 'Wanx' : 'Wan';
      if (/^t2i$/i.test(part)) return 'T2I';
      if (/^i2i$/i.test(part)) return 'I2I';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function uniqueModels(models, sourceName) {
  if (models.length === 0) throw new Error(`${sourceName} image catalog returned no models`);
  const unique = new Map();
  for (const model of models) {
    if (!model.id || !model.name) throw new Error(`${sourceName} image catalog returned an invalid model`);
    if (unique.has(model.id)) throw new Error(`${sourceName} image catalog returned duplicate model ${model.id}`);
    unique.set(model.id, model);
  }
  return [...unique.values()].sort((left, right) => (
    String(right.releaseDate ?? '').localeCompare(String(left.releaseDate ?? ''))
    || left.id.localeCompare(right.id)
  ));
}
