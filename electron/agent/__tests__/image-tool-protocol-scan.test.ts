/**
 * 图片工具装配与退役执行链扫描：
 * - 工具矩阵：通用 Director/Worker 与 Browser Skill Director 含 generate_image；
 *   Browser Skill 专属 Worker 不含；image-runner 不再注册；
 * - 全库零残留：syncExecution / waitForSubagentCompletion / syncCompletionWaiters /
 *   image-runner / RuntimeTaskGroup / scope.run / scope.join。
 * 禁词全部用拼接构造，防止本文件自匹配。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { specRegistry } from '../specs/index.js';

const repoRoot = path.resolve(__dirname, '../../..');

const EXCLUDED_SEGMENTS = ['node_modules', 'dist', 'dist-electron', '__snapshots__'];

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_SEGMENTS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scan(files: string[], tokens: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const token of tokens) {
      if (content.includes(token)) {
        hits.push(`${path.relative(repoRoot, file)} 含禁词 "${token}"`);
      }
    }
  }
  return hits;
}

describe('工具矩阵与 Spec 注册', () => {
  const withGenerateImage = [
    'director',
    'system-chat',
    'browser-worker',
    'local-worker',
    'browser-skill-director',
  ];
  const withoutGenerateImage = ['site-scout', 'browser-skill-builder', 'browser-skill-verifier'];

  it.each(withGenerateImage)('%s 的工具面含 generate_image', (name) => {
    const spec = specRegistry.get(name);
    expect(spec, `spec ${name} 必须存在`).toBeDefined();
    expect(spec!.tools.customTools).toContain('generate_image');
  });

  it.each(withoutGenerateImage)('%s 不含 generate_image', (name) => {
    const spec = specRegistry.get(name);
    expect(spec, `spec ${name} 必须存在`).toBeDefined();
    expect(spec!.tools.customTools ?? []).not.toContain('generate_image');
    expect(spec!.modules, `${name} 不应装配无调用入口的 image module`).not.toContain('image');
  });

  it('通用 worker 都装配 image module', () => {
    for (const name of ['browser-worker', 'local-worker']) {
      expect(specRegistry.get(name)!.modules, `${name} modules`).toContain('image');
    }
  });

  it('image-runner 不再注册：subagent(type: "image-runner") 是未知类型', () => {
    expect(specRegistry.get('image' + '-runner')).toBeUndefined();
    expect(specRegistry.getAll().map(s => s.name)).not.toContain('image' + '-runner');
  });
});

describe('可执行源码零残留', () => {
  const allSources = ['electron', 'src', 'shared']
    .flatMap(d => collectSources(path.join(repoRoot, d)))
    .filter(f => !f.endsWith('image-tool-protocol-scan.test.ts'));

  it('同步执行链零残留：syncExecution / waitForSubagentCompletion / syncCompletionWaiters / _lastSentEvent', () => {
    const tokens = [
      'sync' + 'Execution',
      'waitForSubagent' + 'Completion',
      'syncCompletion' + 'Waiters',
      '_lastSent' + 'Event',
    ];
    expect(scan(allSources, tokens)).toEqual([]);
  });

  it('image-runner 零残留', () => {
    expect(scan(allSources, ['image' + '-runner', 'imageRunner' + 'Spec'])).toEqual([]);
  });

  it('lifetime 取消域不存在：RuntimeTaskGroup / scope.run / scope.join 零残留', () => {
    const tokens = [
      'RuntimeTask' + 'Group',
      'scope.run' + '(',
      'scope.join' + '(',
    ];
    expect(scan(allSources, tokens)).toEqual([]);
  });
});
