import { describe, expect, it } from 'vitest';

import { buildHistoryMenu, buildSessionMenu } from '../sessionMenu';

describe('session rename menu visibility', () => {
  it('offers rename for sidebar live rows without adding it to other live menus', () => {
    expect(buildSessionMenu({
      phase: 'waiting',
      agentId: 'sample-main',
      renamable: true,
    }).map((item) => item.key)).toContain('rename');

    expect(buildSessionMenu({
      phase: 'waiting',
      agentId: 'sample-main',
    }).map((item) => item.key)).not.toContain('rename');
  });

  it('offers rename for persisted rows whether or not deletion is available', () => {
    expect(buildHistoryMenu({ deletable: true }).map((item) => item.key)).toContain('rename');
    expect(buildHistoryMenu({ deletable: false }).map((item) => item.key)).toContain('rename');
  });
});
