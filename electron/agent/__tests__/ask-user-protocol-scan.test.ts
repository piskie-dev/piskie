/**
 * 可执行源码与测试扫描：
 * electron/、src/、shared/ 的 .ts/.tsx（含测试）不得残留——
 * 本地协议错误结构、旧 answer IPC 链、权威 pending 内存状态、IM 假能力四件套；
 * 提示词源码不得残留"系统不会挂起/等待期间勿操作"类旧契约文案。
 * 禁词全部用拼接构造，防止本文件自匹配。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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

describe('可执行源码与测试零残留', () => {
  const allSources = ['electron', 'src', 'shared']
    .flatMap(d => collectSources(path.join(repoRoot, d)))
    .filter(f => f !== __filename.replace(/\.js$/, '.ts') && !f.endsWith('ask-user-protocol-scan.test.ts'));

  it('无本地协议错误结构（结算只有真实答案与 canonical interrupted 两类）', () => {
    const tokens = [
      'ConversationProtocol' + 'Error',
      'ProtocolErrorTool' + 'Result',
      'protocol' + '_error',   // 运行时字面量与测试断言一并禁止
    ];
    expect(scan(allSources, tokens)).toEqual([]);
  });

  it('无旧 answer IPC 链（专用回答通道已删，答案 = 普通用户事件）', () => {
    const tokens = ['ANSWER_' + 'QUESTION', 'answer' + 'Question'];
    expect(scan(allSources, tokens)).toEqual([]);
  });

  it('无权威 pending 内存状态与随机问题 ID（pending 唯一真相 = 尾部未配对 ask_user）', () => {
    // pendingQuestions（复数）= 旧 ReplyInterceptor 权威 Map；单数 pendingQuestion 是合法派生投影
    const tokens = ['pending' + 'Questions', 'question' + 'Id:'];
    expect(scan(allSources, tokens)).toEqual([]);
  });

  it('electron 侧无 IM 假能力四件套（IM 问答能力整体移交）', () => {
    const electronSources = allSources.filter(f => f.includes(`${path.sep}electron${path.sep}`));
    const tokens = [
      'onQuestion' + 'Pending',
      'handleInbound' + 'AsAnswer',
      'hasPending' + 'Question',
      'tool_pending' + '_user_input',
    ];
    expect(scan(electronSources, tokens)).toEqual([]);
  });
});

describe('提示词与工具描述不含旧等待契约文案', () => {
  it('prompts/ 与 ask-user 工具源码不含"不会挂起/等待期间勿操作/答案将以事件"', () => {
    const files = [
      ...collectSources(path.join(repoRoot, 'electron/agent/prompts')),
      path.join(repoRoot, 'electron/tools/plan/ask-user.tool.ts'),
    ];
    const tokens = ['不会挂起', '等待期间勿操作', '答案将以事件'];
    expect(scan(files, tokens)).toEqual([]);
  });
});
