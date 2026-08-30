/**
 * 命令语法解析规则
 */

import { describe, it, expect } from 'vitest';
import { parseRegisteredCommand } from '../command-parser.js';
import type { IMCommandHandler } from '../command-types.js';

const stubHandler = (name: string): IMCommandHandler => ({
  name,
  execute: async () => ({ handled: true, ok: true, directResponse: { text: 'ok' } }),
});

const handlers = new Map<string, IMCommandHandler>([
  ['clear', stubHandler('clear')],
]);

describe('parseRegisteredCommand', () => {
  it('精确 /clear 命中：name=clear, args=[]', () => {
    expect(parseRegisteredCommand('/clear', handlers)).toEqual({
      name: 'clear',
      args: [],
      raw: '/clear',
    });
  });

  it('/clear extra 解析出 args，由 handler 决定用法错误', () => {
    expect(parseRegisteredCommand('/clear extra', handlers)).toEqual({
      name: 'clear',
      args: ['extra'],
      raw: '/clear extra',
    });
  });

  it('普通文本中包含 /clear 不触发', () => {
    expect(parseRegisteredCommand('请帮我 /clear 一下', handlers)).toBeNull();
    expect(parseRegisteredCommand('someprefix/clear', handlers)).toBeNull();
  });

  it('未注册 /foo 返回 null，保持普通用户文本', () => {
    expect(parseRegisteredCommand('/foo', handlers)).toBeNull();
    expect(parseRegisteredCommand('/foo bar', handlers)).toBeNull();
  });

  it('命令名大小写不敏感，args 原样保留', () => {
    expect(parseRegisteredCommand('/CLEAR', handlers)).toEqual({
      name: 'clear',
      args: [],
      raw: '/CLEAR',
    });
    const parsed = parseRegisteredCommand('/Clear ABC', handlers);
    expect(parsed?.name).toBe('clear');
    expect(parsed?.args).toEqual(['ABC']);
  });

  it('裸 / 或空文本返回 null', () => {
    expect(parseRegisteredCommand('/', handlers)).toBeNull();
    expect(parseRegisteredCommand('', handlers)).toBeNull();
  });

  it('QQ 群历史信封包装后的文本（历史段落 + /clear）不是精确命令，不命中', () => {
    expect(parseRegisteredCommand('[10:00] 张三: 早上好\n/clear', handlers)).toBeNull();
  });
});
