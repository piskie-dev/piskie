import { describe, expect, it, vi } from 'vitest';

import type { CatalogEntry } from '../../catalog.js';
import type { PreparedCall, ToolContext } from '../../types.js';
import { decideApproval } from '../approval-policy.js';

function call(
  action: 'create' | 'read',
  mode: string,
  approvalMode: 'auto' | 'confirm',
): PreparedCall<unknown> {
  return {
    entry: { modelName: 'plan' } as CatalogEntry,
    params: { action },
    ctx: {
      modes: {
        modeId: () => mode,
        approvalMode: () => approvalMode,
      },
    } as ToolContext,
    callId: 'call-1',
  };
}

describe('plan(create) approval policy', () => {
  it.each([
    ['normal', 'auto'],
    ['normal', 'confirm'],
    ['plan', 'auto'],
    ['plan', 'confirm'],
    ['browser-skill', 'auto'],
    ['browser-skill', 'confirm'],
  ] as const)('%s + %s 始终要求用户审批', (mode, approvalMode) => {
    expect(decideApproval(call('create', mode, approvalMode))).toEqual({
      needs: true,
      reason: '计划正文必须由用户确认。',
      modeInvariant: true,
    });
  });

  it('create 的审批判定不读取当前模式', () => {
    const prepared = call('create', 'normal', 'auto');
    const modeId = vi.fn(() => {
      throw new Error('modeId should not be read');
    });
    prepared.ctx.modes.modeId = modeId;

    expect(decideApproval(prepared)).toMatchObject({ needs: true, modeInvariant: true });
    expect(modeId).not.toHaveBeenCalled();
  });

  it.each([
    ['normal', 'auto'],
    ['normal', 'confirm'],
    ['plan', 'auto'],
    ['browser-skill', 'confirm'],
  ] as const)('%s + %s 下 read 不强制审批', (mode, approvalMode) => {
    expect(decideApproval(call('read', mode, approvalMode))).toEqual({ needs: false });
  });
});
