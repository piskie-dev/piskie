import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertRecords } from './schema.mjs';
import { summarizeRecords } from './metrics.mjs';
import { compareRecords } from './compare.mjs';
import { DEFINITIONS, renderMarkdown, renderHtml } from './render.mjs';

export { validateRecord } from './schema.mjs';
export { summarizeRecords } from './metrics.mjs';

/** Pure report generation. The json property is an object, not a serialized string. */
export function buildReport(records, { baselineRecords = [] } = {}) {
  assertRecords(records);
  assertRecords(baselineRecords, 'baselineRecords');
  const json = {
    schemaVersion: 1,
    reportType: 'browser-benchmark',
    definitions: [...DEFINITIONS],
    records: structuredClone(records),
    baselineRecords: structuredClone(baselineRecords),
    summary: summarizeRecords(records),
    comparison: compareRecords(records, baselineRecords),
  };
  return { json, markdown: renderMarkdown(json), html: renderHtml(json) };
}

/** Write three offline artifacts; return their absolute paths. */
export async function writeReport(records, { outputDir, baselineRecords = [] } = {}) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new TypeError('outputDir must be a nonempty directory path');
  const report = buildReport(records, { baselineRecords });
  const directory = resolve(outputDir);
  const paths = { json: join(directory, 'report.json'), markdown: join(directory, 'report.md'), html: join(directory, 'report.html') };
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(report.json, null, 2)}\n`, 'utf8'),
    writeFile(paths.markdown, report.markdown, 'utf8'),
    writeFile(paths.html, report.html, 'utf8'),
  ]);
  return paths;
}
