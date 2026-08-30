import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import type { ConversationEntry, PersistedMessageBlock } from '../../../../../shared/types/agent-control';
import type { TaskItem } from '../../../../../shared/types';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import '@/i18n';
import {
  rawText,
  resolvePresentationText,
  type PresentationText,
} from '../presentationText';
import { resolveActivitySummary, truncateInline } from '../useActivitySummary';

function task(id: string, subject: string, status: TaskItem['status']): TaskItem {
  return { id, subject, description: '', status, owner: null, dependsOn: [] };
}

function cellsFrom(entries: ConversationEntry[]) {
  return projectConversationNodes(entries);
}

function assistantMsg(id: string, content: PersistedMessageBlock[]): ConversationEntry {
  return { t: 'msg', ts: 1, id, role: 'assistant', content };
}

function render(text: PresentationText, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const translate = i18n.getFixedT(locale);
  return resolvePresentationText(text, (key, values) => translate(key, values ?? {}));
}

describe('resolveActivitySummary priority', () => {
  it('awaiting answer wins and keeps the question raw inside localized count copy', () => {
    const summary = resolveActivitySummary({
      phase: 'waiting',
      askUser: { items: [{ question: '要用哪个账号登录？' }, { question: '需要代理吗？' }] },
      pendingToolName: 'write',
      taskBoard: { items: [task('t1', '抓取', 'in_progress')] },
    });

    expect(summary.kind).toBe('awaiting-answer');
    expect(render(summary.text, 'zh-CN')).toBe('要用哪个账号登录？（共 2 题）');
    expect(render(summary.text, 'en-US')).toBe('要用哪个账号登录？ (2 questions)');
  });

  it('single question remains an unmodified raw fact', () => {
    const summary = resolveActivitySummary({
      phase: 'waiting',
      askUser: { items: [{ question: '继续吗？' }] },
    });
    expect(summary.text).toEqual(rawText('继续吗？'));
    expect(render(summary.text, 'en-US')).toBe('继续吗？');
  });

  it('awaiting approval uses the semantic tool title without name substring guessing', () => {
    const summary = resolveActivitySummary({
      phase: 'stopping',
      interrupted: true,
      pendingToolName: 'write',
      taskBoard: { items: [task('t1', '抓取', 'pending')] },
    });

    expect(summary.kind).toBe('awaiting-approval');
    expect(render(summary.text, 'zh-CN')).toBe('写入文件');
    expect(render(summary.text, 'en-US')).toBe('Write file');

    const unknown = resolveActivitySummary({
      phase: 'waiting',
      pendingToolName: 'vendor_clickish_name',
    });
    expect(render(unknown.text)).toBe('vendor_clickish_name');
  });

  it('stopping wins over the interrupted steady state', () => {
    const stopping = resolveActivitySummary({ phase: 'stopping', interrupted: true });
    expect(stopping.kind).toBe('stopping');
    expect(render(stopping.text, 'en-US')).toBe('Stopping');

    const interrupted = resolveActivitySummary({ phase: 'waiting', interrupted: true });
    expect(interrupted.kind).toBe('interrupted');
  });

  it('projects task progress with the current subject as raw text', () => {
    const summary = resolveActivitySummary({
      phase: 'executing',
      taskBoard: {
        items: [
          task('t1', '登录', 'completed'),
          task('t2', '抓取列表', 'in_progress'),
          task('t3', '导出', 'pending'),
        ],
      },
    });

    expect(summary.kind).toBe('tasks');
    expect(render(summary.text)).toBe('1/3 · 抓取列表');
    expect(render(summary.text, 'en-US')).toBe('1/3 · 抓取列表');
  });

  it('omits the current subject after every task completes', () => {
    const summary = resolveActivitySummary({
      phase: 'waiting',
      taskBoard: { items: [task('t1', '登录', 'completed')] },
    });
    expect(render(summary.text)).toBe('1/1');
  });

  it('falls back to the latest projected action without inferring an action verb', () => {
    const summary = resolveActivitySummary({
      phase: 'executing',
      nodes: cellsFrom([
        assistantMsg('a1', [{
          type: 'tool_use',
          id: 'c1',
          name: 'browser_navigate',
          input: { url: 'https://x.com' },
        }]),
      ]),
    });

    expect(summary.kind).toBe('action');
    expect(render(summary.text)).toBe('browser_navigate · https://x.com');
  });

  it('skips user messages and keeps model text raw', () => {
    const summary = resolveActivitySummary({
      phase: 'waiting',
      nodes: cellsFrom([
        assistantMsg('a2', [{ type: 'text', text: '我先看一下页面' }]),
        { t: 'msg', ts: 2, id: 'u1', role: 'user', subtype: 'user_input', content: '好的' },
      ]),
    });

    expect(summary.kind).toBe('action');
    expect(render(summary.text, 'zh-CN')).toBe('我先看一下页面');
    expect(render(summary.text, 'en-US')).toBe('我先看一下页面');
  });

  it('uses thinking before the idle fallback', () => {
    expect(resolveActivitySummary({ phase: 'thinking' }).kind).toBe('thinking');
  });

  it('preserves an explicit raw fallback', () => {
    const summary = resolveActivitySummary({
      phase: 'waiting',
      fallback: rawText('等待 agent 启动'),
    });
    expect(summary.kind).toBe('idle');
    expect(render(summary.text, 'en-US')).toBe('等待 agent 启动');
  });
});

describe('truncateInline', () => {
  it('collapses whitespace and truncates by length', () => {
    expect(truncateInline('  多个   空白\n换行  ')).toBe('多个 空白 换行');
    expect(truncateInline('abcdefghij', 5)).toBe('abcde...');
  });

  it('returns undefined for empty content', () => {
    expect(truncateInline('   ')).toBeUndefined();
    expect(truncateInline(undefined)).toBeUndefined();
  });
});
