/**
 * 群 sender 信封与 senderId 防御校验
 */

import { describe, it, expect } from 'vitest';
import { buildAgentText, hasValidSenderId } from '../sender-envelope.js';
import type { InboundMessage } from '../channel-connector.js';

function msg(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    peer: { kind: 'group', id: 'room-1' },
    senderId: 'u-1',
    text: 'hello',
    ...overrides,
  };
}

describe('hasValidSenderId', () => {
  it('非空稳定值有效', () => {
    expect(hasValidSenderId('u-123')).toBe(true);
    expect(hasValidSenderId(' padded ')).toBe(true); // trim 只做校验，原值仍稳定
  });

  it('缺失、空白、哨兵值 unknown 都无效', () => {
    expect(hasValidSenderId(undefined)).toBe(false);
    expect(hasValidSenderId(null)).toBe(false);
    expect(hasValidSenderId('')).toBe(false);
    expect(hasValidSenderId('   ')).toBe(false);
    expect(hasValidSenderId('\t\n')).toBe(false);
    expect(hasValidSenderId('unknown')).toBe(false);
    expect(hasValidSenderId(' unknown ')).toBe(false);
  });
});

describe('buildAgentText', () => {
  it('私聊正文逐字原样，不加信封', () => {
    expect(buildAgentText(msg({ peer: { kind: 'direct', id: 'u-1' } }), '原文 保持')).toBe('原文 保持');
  });

  it('群聊首行严格为 [IM_GROUP_MEMBER {"id":...,"name":...}]，正文从下一行开始', () => {
    const text = buildAgentText(msg({ senderId: 'u-9', senderName: '张三' }), '早上好');
    const [first, ...rest] = text.split('\n');
    expect(first).toBe('[IM_GROUP_MEMBER {"id":"u-9","name":"张三"}]');
    expect(rest.join('\n')).toBe('早上好');
  });

  it('senderName 缺失 → name 为 null（JSON），不回填 unknown', () => {
    const text = buildAgentText(msg({ senderId: 'u-9', senderName: undefined }), 'hi');
    expect(text.split('\n')[0]).toBe('[IM_GROUP_MEMBER {"id":"u-9","name":null}]');
  });

  it('引号/反斜线/换行经 JSON 转义，信封仍只占一行', () => {
    const text = buildAgentText(
      msg({ senderId: 'u"\\1', senderName: '多\n行"名' }),
      'body',
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('body');
    const parsed = JSON.parse(lines[0].slice('[IM_GROUP_MEMBER '.length, -1)) as { id: string; name: string };
    expect(parsed.id).toBe('u"\\1');
    expect(parsed.name).toBe('多\n行"名');
  });

  it('NEL/U+2028/U+2029 额外转义为 \\uXXXX，不破坏单行', () => {
    const trickyName = 'a\u0085b\u2028c\u2029d';
    const text = buildAgentText(msg({ senderId: 'u-1', senderName: trickyName }), 'body');
    const firstLine = text.split('\n')[0];
    expect(firstLine).toContain('\\u0085');
    expect(firstLine).toContain('\\u2028');
    expect(firstLine).toContain('\\u2029');
    expect(firstLine).not.toMatch(/[\u0085\u2028\u2029]/);
    // 转义可逆：JSON.parse 还原原始字符
    const parsed = JSON.parse(firstLine.slice('[IM_GROUP_MEMBER '.length, -1)) as { name: string };
    expect(parsed.name).toBe(trickyName);
  });

  it('群聊纯图片空正文仍有信封（图片为空正文是合法输入）', () => {
    const text = buildAgentText(msg({ senderId: 'u-9', senderName: '张三' }), '');
    expect(text).toBe('[IM_GROUP_MEMBER {"id":"u-9","name":"张三"}]\n');
  });
});
