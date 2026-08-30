/**
 * 工具产物数据流的静态收口扫描：
 * - 通用透传层与前端通用组件不得出现按工具名的 artifact 分支
 *   （kind 构造只允许在 edit 成功出口与 ask_user 配对边界）；
 * - 上下文/replay 层（electron/agent/context）零 artifacts 读取；
 * - 不存在工具产物域的 ArtifactStore / 独立恢复索引
 *   （electron/inference 的 ArtifactStore 属于图片生成域，不在本协议范围）。
 * 禁词用拼接构造，防本文件自匹配。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

/** 通用层：Coordinator→PendingSettlement→Settler→Store→前端投影/审阅/详情 */
const GENERIC_LAYER = [
  'electron/tools/coordinator.ts',
  'electron/tools/base-tool.ts',
  'electron/tools/types.ts',
  'electron/agent/tool-call/pending-settlement.ts',
  'electron/agent/conversation/settler.ts',
  'electron/agent-runs/conversation-store.ts',
  'src/features/console/data/cells/toolCell.ts',
  'src/features/console/data/review.ts',
  'src/features/console/data/toolArtifacts.ts',
  'src/features/console/content/ThreadCell.tsx',
];

const EDIT_LIT = "'" + 'edit' + "'";
const ASK_LIT = "'" + 'ask_user' + "'";
const FORBIDDEN_BRANCHES = [
  'toolName === ' + EDIT_LIT,
  'toolName === ' + ASK_LIT,
  '.tool === ' + EDIT_LIT,
  '.tool === ' + ASK_LIT,
];

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf-8');
}

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-electron', '__tests__'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('静态收口扫描', () => {
  it('通用层零按工具名的 artifact 分支', () => {
    const hits: string[] = [];
    for (const relative of GENERIC_LAYER) {
      const content = read(relative);
      for (const token of FORBIDDEN_BRANCHES) {
        if (content.includes(token)) hits.push(`${relative} 含禁止分支 "${token}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('kind 字面量只出现在契约、两个生产点与前端唯一投影入口', () => {
    // 允许清单：类型契约 / IPC schema / edit 成功出口 / ask_user 配对边界 /
    // 前端 registry 与提交侧。出现在其他可执行源码即为分支扩散。
    const allowed = new Set([
      'shared/types/tool-artifact.ts',
      'shared/types/index.ts',
      'shared/schemas/agent-input.ts',
      'electron/tools/fs/edit.tool.ts',
      'electron/agent/agent-runtime.ts',
      'src/features/console/data/toolArtifacts.ts',
      'src/features/console/data/cells/toolCell.ts',
      'src/features/console/data/cells/detail.ts',
      'src/features/console/data/actions.ts',
      'src/features/console/data/review.ts',
    ]);
    const kindLiterals = ["'" + 'file_diff' + "'", "'" + 'ask_user_answers' + "'"];
    const hits: string[] = [];
    for (const dir of ['shared', 'electron', 'src'].map((seg) => path.join(repoRoot, seg))) {
      for (const file of collectSources(dir)) {
        const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
        if (allowed.has(relative)) continue;
        const content = fs.readFileSync(file, 'utf-8');
        for (const literal of kindLiterals) {
          if (content.includes(literal)) hits.push(`${relative} 含 kind 字面量 ${literal}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('上下文/replay 层零 artifacts 读取', () => {
    const contextDir = path.join(repoRoot, 'electron/agent/context');
    const hits: string[] = [];
    for (const file of collectSources(contextDir)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('artifact')) {
        hits.push(path.relative(repoRoot, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it('不存在工具产物域的 ArtifactStore / 全局产物索引', () => {
    const hits: string[] = [];
    for (const dir of ['src/features/console', 'electron/tools', 'electron/agent', 'electron/core']) {
      for (const file of collectSources(path.join(repoRoot, dir))) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const token of ['class ArtifactStore', 'new ArtifactStore', 'interface ArtifactStore']) {
          if (content.includes(token)) {
            hits.push(`${path.relative(repoRoot, file)} 含 "${token}"`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
