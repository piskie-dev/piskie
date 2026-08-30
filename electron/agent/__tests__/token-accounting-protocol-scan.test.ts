/**
 * Token 计量结构性门禁。
 *
 * 这两条锁的不是某个函数的返回值，而是**仓库里不再存在某一类代码**：
 * token 求和只能出现在一处、本地估算一处都不能有。它们靠断言写不出来——
 * 断言只能证明现有调用点是对的，证明不了没有人新开第二个。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCAN_ROOTS = ['electron', 'shared', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '__tests__', 'lib']);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    yield full;
  }
}

function scanProduction(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(ROOT, root))) {
      const relative = file.slice(ROOT.length + 1);
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  return hits;
}

describe('本地估算整体不存在', () => {
  it('生产代码零命中 estimateTokens / estimatedTokens / maxToolResultRatio', () => {
    // 上下文大小只认 provider 的精确值。留一个估算器在仓库里，
    // 下一个人就会在新的决策点使用它，重新形成多份互相漂移的实现。
    expect(scanProduction(/\b(estimateTokens|estimatedTokens|estimateMessageTokens|estimateToolsTokens|estimateContentBlockTokens|maxToolResultRatio)\b/))
      .toEqual([]);
  });
});

describe('token 求和只有一处', () => {
  it('读 provider 原始 usage 字段的文件，一律经由 normalizeUsage', () => {
    // 同一组字段名在不同 provider 下语义相反（Anthropic 的 input_tokens 不含缓存、
    // OpenAI 的 cached_tokens 是 input_tokens 的明细）。让每个 driver「各自算对」
    // 会形成三个互相看不见的加号，其中任一实现都可能单独算错。
    // 所以判据不是「谁写了加号」，是「谁在没有 normalizeUsage 的情况下碰了原始字段」。
    const RAW_USAGE_FIELD = /usage[?.]*\.(input_tokens|output_tokens|prompt_tokens|completion_tokens|cached_tokens|cache_read_input_tokens|cache_creation_input_tokens)\b/;
    const offenders = new Set<string>();
    for (const file of sourceFiles(join(ROOT, 'electron', 'inference'))) {
      const source = readFileSync(file, 'utf8');
      if (!RAW_USAGE_FIELD.test(source)) continue;
      if (source.includes('normalizeUsage')) continue;
      offenders.add(file.slice(ROOT.length + 1));
    }
    expect([...offenders]).toEqual([]);
  });
});
