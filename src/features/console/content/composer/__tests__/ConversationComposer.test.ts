import { describe, expect, it } from 'vitest';

import { resolveComposerMainAction } from '../composerMainAction';

describe('resolveComposerMainAction', () => {
  it('uses one stable action slot for send, pending send, interrupt, and stopping', () => {
    expect(resolveComposerMainAction(false, false, false, null))
      .toEqual({ kind: 'send', disabled: true });
    expect(resolveComposerMainAction(true, false, false, null))
      .toEqual({ kind: 'send', disabled: false });
    expect(resolveComposerMainAction(true, false, false, 'send'))
      .toEqual({ kind: 'sending', disabled: true });
    expect(resolveComposerMainAction(true, true, false, null))
      .toEqual({ kind: 'interrupt', disabled: false });
    expect(resolveComposerMainAction(true, false, false, 'interrupt'))
      .toEqual({ kind: 'interrupt', disabled: true });
    expect(resolveComposerMainAction(true, false, true, null))
      .toEqual({ kind: 'interrupt', disabled: true });
  });

  it('keeps the icon for the action already in flight when stopping arrives', () => {
    expect(resolveComposerMainAction(true, true, true, 'send'))
      .toEqual({ kind: 'sending', disabled: true });
    expect(resolveComposerMainAction(true, false, true, 'interrupt'))
      .toEqual({ kind: 'interrupt', disabled: true });
  });
});
