import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_HISTORY_LIMIT,
  clearAllComposerDrafts,
  composerDraftKey,
  submitComposerDraft,
  useComposerDraftStore,
} from '../composer-drafts';

describe('composer-drafts(输入草稿驻留)', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
  });

  it('按键位驻留与读回', () => {
    const { setDraft } = useComposerDraftStore.getState();
    setDraft('welcome', '帮我盘一下竞品');
    setDraft(composerDraftKey('ag-1'), '继续上一步');
    setDraft(composerDraftKey('ag-1', 'wk-1'), '换个搜索词');

    const { drafts } = useComposerDraftStore.getState();
    expect(drafts['welcome']?.text).toBe('帮我盘一下竞品');
    expect(drafts['agent:ag-1']?.text).toBe('继续上一步');
    expect(drafts['worker:ag-1:wk-1']?.text).toBe('换个搜索词');
  });

  it('清空即从账上删除(发送成功路径)', () => {
    const { setDraft } = useComposerDraftStore.getState();
    setDraft('welcome', '草稿');
    setDraft('welcome', '');
    expect('welcome' in useComposerDraftStore.getState().drafts).toBe(false);
  });

  it('不同目标互不串稿', () => {
    const { setDraft } = useComposerDraftStore.getState();
    setDraft(composerDraftKey('ag-1'), 'A 的话');
    expect(useComposerDraftStore.getState().drafts[composerDraftKey('ag-2')]).toBeUndefined();
  });

  it('keeps bounded, deduplicated submission history per target', () => {
    const firstKey = composerDraftKey('agent-a');
    const secondKey = composerDraftKey('agent-b');
    const { recordHistory } = useComposerDraftStore.getState();

    recordHistory(firstKey, '');
    for (let index = 0; index < COMPOSER_HISTORY_LIMIT + 3; index += 1) {
      recordHistory(firstKey, `Request ${index}`);
    }
    recordHistory(firstKey, `Request ${COMPOSER_HISTORY_LIMIT + 2}`);
    recordHistory(secondKey, 'Separate request');

    const { histories } = useComposerDraftStore.getState();
    expect(histories[firstKey]).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(histories[firstKey]?.[0]).toBe('Request 3');
    expect(histories[firstKey]?.at(-1)).toBe(`Request ${COMPOSER_HISTORY_LIMIT + 2}`);
    expect(histories[secondKey]).toEqual(['Separate request']);
  });

  it('records the accepted snapshot and retains edits made while it is submitting', async () => {
    const key = composerDraftKey('agent-a');
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    useComposerDraftStore.getState().setDraft(key, 'First request');

    const submission = submitComposerDraft(key, async (snapshot) => {
      expect(snapshot.text).toBe('First request');
      await accepted;
      return true;
    });
    useComposerDraftStore.getState().setDraft(key, 'Unsaved follow-up');
    accept();

    await expect(submission).resolves.toBe(true);
    expect(useComposerDraftStore.getState().histories[key]).toEqual(['First request']);
    expect(useComposerDraftStore.getState().drafts[key]?.text).toBe('Unsaved follow-up');
  });

  it('does not record a rejected submission', async () => {
    const key = composerDraftKey('agent-a');
    useComposerDraftStore.getState().setDraft(key, 'Rejected request');

    await expect(submitComposerDraft(key, async () => false)).resolves.toBe(false);

    expect(useComposerDraftStore.getState().histories[key]).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts[key]?.text).toBe('Rejected request');
  });

  it('文字与附件共享目标记录并可分别清空', () => {
    const key = composerDraftKey('ag-1');
    const { appendFiles, clearAttachments, setDraft } = useComposerDraftStore.getState();
    setDraft(key, '检查附件');
    appendFiles(key, [{ id: 'file-1', name: 'notes.md', path: '/tmp/notes.md' }]);

    setDraft(key, '');
    expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({
      text: '',
      attachments: { files: [{ path: '/tmp/notes.md' }] },
    });

    clearAttachments(key);
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
  });

  it('starts a fresh renderer with confirmation even after a previous renderer selected auto', async () => {
    useComposerDraftStore.getState().selectApprovalMode('auto');
    vi.resetModules();
    const fresh = await import('../composer-drafts');
    expect(fresh.useComposerDraftStore.getState().defaults.approvalMode).toBe('confirm');
  });
});
