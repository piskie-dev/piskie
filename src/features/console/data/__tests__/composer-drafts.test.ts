import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllComposerDrafts,
  composerDraftKey,
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
});
