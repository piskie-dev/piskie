import { describe, expect, it } from 'vitest';

import type { MessagingConnectionState } from '../../../../../shared/electron-contracts/messaging';
import { claimTemplateOptions } from '../template-claims';

function bot(id: string, name: string, definitionId?: string): MessagingConnectionState {
  return { config: { id, channelType: 'feishu', name, definitionId }, status: 'stopped' };
}

const templates = [
  { definitionId: 'def-a', name: '客服值守', purpose: 'messaging' as const, createdAt: '2026-08-01T00:00:00Z' },
  { definitionId: 'def-b', name: '微信助手', purpose: 'messaging' as const, createdAt: '2026-08-19T00:00:00Z' },
  { definitionId: 'def-c', name: '巡检', purpose: 'messaging' as const, createdAt: '2026-08-10T00:00:00Z' },
  { definitionId: 'def-general', name: '普通任务', purpose: 'general' as const, createdAt: '2026-08-20T00:00:00Z' },
];

describe('claimTemplateOptions', () => {
  it('最新创建排前;被他人占用 lockedByOther 并列出占用者', () => {
    const claims = claimTemplateOptions(templates, [bot('b1', '飞书值班', 'def-a')], 'b2');
    expect(claims.map((c) => c.id)).toEqual(['def-b', 'def-c', 'def-a']);
    const taken = claims.find((c) => c.id === 'def-a')!;
    expect(taken.lockedByOther).toBe(true);
    expect(taken.holders).toEqual(['飞书值班']);
    expect(claims.find((c) => c.id === 'def-b')!.lockedByOther).toBe(false);
  });

  it('只提供 messaging 用途的任务模板', () => {
    const claims = claimTemplateOptions(templates, []);

    expect(claims.some((claim) => claim.id === 'def-general')).toBe(false);
  });

  it('自己占用的不锁(编辑态保持现绑可选)', () => {
    const claims = claimTemplateOptions(templates, [bot('b1', '飞书值班', 'def-a')], 'b1');
    expect(claims.find((c) => c.id === 'def-a')!.lockedByOther).toBe(false);
  });

  it('未传 selfBotId(新建态):所有已绑模板都锁', () => {
    const claims = claimTemplateOptions(templates, [bot('b1', '飞书值班', 'def-a')]);
    expect(claims.find((c) => c.id === 'def-a')!.lockedByOther).toBe(true);
  });
});
