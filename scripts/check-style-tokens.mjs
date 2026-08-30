#!/usr/bin/env node
/**
 * 样式 token 检查
 *
 * 扫描 src/**\/*.tsx 中的彩色硬编码（#hex 与 rgb/rgba 字面量，黑/白透明度豁免），
 * 发现任意未豁免的彩色硬编码即退出 1，必须改用 token。
 *
 * 行级豁免：行尾加 `// style-token-ignore` 注释（canvas/WebGL/色值插值计算等非 CSS 消费场景）。
 *
 * 用法：npm run check:styles
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

// #3 位以上 hex，或 rgb(/rgba( 字面量；color-mix(in srgb, var(...)) 属合法用法不匹配
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g;
const IGNORE_MARK = 'style-token-ignore';

/** 黑/白透明度（阴影、遮罩、发丝线、白透明递阶）属 Console 基准视觉语言，不算违规 */
function isNeutral(token) {
  if (token.startsWith('#')) {
    const hex = token.slice(1).toLowerCase();
    const core = hex.length >= 6 ? hex.slice(0, 6) : hex.slice(0, 3);
    return core === 'ffffff' || core === '000000' || core === 'fff' || core === '000';
  }
  const ch = token.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!ch) return false;
  const [r, g, b] = [Number(ch[1]), Number(ch[2]), Number(ch[3])];
  return (r === 255 && g === 255 && b === 255) || (r === 0 && g === 0 && b === 0);
}

/** 该行是否存在非中性色（黑白以外）的颜色字面量 */
function hasColoredLiteral(line) {
  for (const m of line.matchAll(COLOR_RE)) {
    const token = m[0].startsWith('#')
      ? m[0]
      : line.slice(m.index).match(/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/)?.[0] ?? m[0];
    if (!isNeutral(token)) return true;
  }
  return false;
}

/** 收集 .tsx 文件 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

// 逐文件统计违规行
const counts = {}; // 相对路径 -> 计数
const detail = {}; // 相对路径 -> [行描述]
for (const file of collect(SRC)) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    if (line.includes(IGNORE_MARK)) return;
    if (!hasColoredLiteral(line)) return;
    // 跳过纯注释行（文档性示例）
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    counts[rel] = (counts[rel] || 0) + 1;
    (detail[rel] ||= []).push(`${rel}:${idx + 1}  ${trimmed.slice(0, 120)}`);
  });
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (total > 0) {
  for (const [rel, count] of Object.entries(counts)) {
    console.error(`✖ ${rel}：彩色硬编码 ${count} 处（应使用 cyber-*/status-*/surface-*/line-* token）`);
    for (const d of detail[rel]) console.error('    ' + d);
  }
  console.error(`\n新增颜色请先加 token（src/styles/tokens.css）。`);
  console.error(`确属非 CSS 消费场景（canvas/WebGL/色值计算）可在行尾加 // ${IGNORE_MARK} 豁免。`);
  process.exit(1);
}

console.log('✓ 通过（零彩色硬编码）');
