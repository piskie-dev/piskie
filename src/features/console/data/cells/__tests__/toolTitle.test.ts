import { describe, expect, it } from 'vitest';

import { resolveToolTitle } from '../toolTitle';

describe('skill_call title projection', () => {
  it('shows skill.function without changing the underlying tool name', () => {
    const input = {
      tool: 'skill_call',
      params: { skill: 'example-site', function: 'searchOptions', args: { query: 'x' } },
    } as const;

    expect(resolveToolTitle(input)).toEqual({
      titleKey: 'transcript.tool.skillFunction',
      titleArgs: { function: 'example-site.searchOptions' },
    });
    expect(input.tool).toBe('skill_call');
    expect(input.params.args).toEqual({ query: 'x' });
  });

  it('falls back to the generic title when routing fields are incomplete', () => {
    expect(resolveToolTitle({ tool: 'skill_call', params: { skill: 'example-site' } }))
      .toEqual({ titleKey: 'transcript.tool.skillCall' });
  });
});

describe('worker tool titles', () => {
  it('maps creation and stop to separate tools without reading an action field', () => {
    expect(resolveToolTitle({ tool: 'subagent', params: { type: 'explore', subject: '查明保存入口' } }))
      .toEqual({ titleKey: 'transcript.tool.createWorker' });
    expect(resolveToolTitle({ tool: 'subagent', params: { action: 'create', subject: '历史记录' } }))
      .toEqual({ titleKey: 'transcript.tool.createWorker' });
    expect(resolveToolTitle({ tool: 'subagent_stop', params: { subagentId: 'worker-a' } }))
      .toEqual({ titleKey: 'transcript.tool.stopWorker' });
  });
});
