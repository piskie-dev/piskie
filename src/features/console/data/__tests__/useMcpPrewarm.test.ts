import { describe, expect, it } from 'vitest';

import { mcpPrewarmRequestKey } from '../useMcpPrewarm';

describe('MCP prewarm request identity', () => {
  it('keeps equivalent request objects on the same lifecycle key', () => {
    expect(mcpPrewarmRequestKey({ workspace: '/work/repo', specName: 'system-chat' }))
      .toBe(mcpPrewarmRequestKey({ workspace: '/work/repo', specName: 'system-chat' }));
  });

  it('treats selection as a set instead of array identity or order', () => {
    expect(mcpPrewarmRequestKey({
      workspace: '/work/repo',
      specName: 'system-chat',
      runSelection: ['godot', 'docs', 'godot'],
    })).toBe(mcpPrewarmRequestKey({
      workspace: '/work/repo',
      specName: 'system-chat',
      runSelection: ['docs', 'godot'],
    }));
  });

  it('changes the key for actual capability inputs', () => {
    const baseline = mcpPrewarmRequestKey({ workspace: '/work/a', specName: 'system-chat' });
    expect(mcpPrewarmRequestKey({ workspace: '/work/b', specName: 'system-chat' }))
      .not.toBe(baseline);
    expect(mcpPrewarmRequestKey({ workspace: '/work/a', specName: 'other-spec' }))
      .not.toBe(baseline);
    expect(mcpPrewarmRequestKey({
      workspace: '/work/a',
      specName: 'system-chat',
      runSelection: [],
    })).not.toBe(baseline);
  });
});
