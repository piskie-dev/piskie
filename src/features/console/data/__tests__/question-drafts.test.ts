import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAgentQuestionDrafts,
  clearAllConsoleDrafts,
  clearAllQuestionDrafts,
  getQuestionDraft,
  getQuestionDraftVersion,
  questionDraftKey,
  reconcileQuestionDrafts,
  useQuestionDraft,
  useQuestionDraftStore,
  type QuestionItemDraft,
} from '../question-drafts';
import { clearAllComposerDrafts, useComposerDraftStore } from '../composer-drafts';

const answer = (custom: string, selected: readonly string[] = []): QuestionItemDraft => ({
  selected,
  custom,
});

function setItem(key: ReturnType<typeof questionDraftKey>, index: number, item: QuestionItemDraft): void {
  useQuestionDraftStore.getState().setItem(key, index, item, getQuestionDraftVersion(key));
}

beforeEach(() => {
  clearAllQuestionDrafts();
  clearAllComposerDrafts();
});

describe('question drafts', () => {
  it('isolates stable agent and request keys', () => {
    const first = questionDraftKey('agent-alpha', 'request-one');
    const second = questionDraftKey('agent-alpha', 'request-two');
    const other = questionDraftKey('agent-beta', 'request-one');

    setItem(first, 0, answer('First answer'));
    setItem(second, 0, answer('', ['Option two']));

    expect(first).toBe('question:agent-alpha:request-one');
    expect(getQuestionDraft(first)[0]).toEqual(answer('First answer'));
    expect(getQuestionDraft(second)[0]).toEqual(answer('', ['Option two']));
    expect(getQuestionDraft(other)).toEqual([]);
  });

  it('retains a padded whole draft across ordinary unmount and remount', async () => {
    const key = questionDraftKey('agent-alpha', 'request-one');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let binding: ReturnType<typeof useQuestionDraft> | undefined;
    let root: Root | undefined;
    const Probe = () => {
      binding = useQuestionDraft(key, 2);
      return null;
    };

    try {
      root = createRoot(document.createElement('div'));
      await act(async () => root?.render(React.createElement(Probe)));
      expect(binding?.[0]).toEqual([
        { selected: [], custom: '' },
        { selected: [], custom: '' },
      ]);
      await act(async () => binding?.[1]((current) => current.map((item, index) => (
        index === 1 ? answer('Second item') : item
      ))));
      await act(async () => root?.unmount());

      root = createRoot(document.createElement('div'));
      await act(async () => root?.render(React.createElement(Probe)));
      expect(binding?.[0][1]).toEqual(answer('Second item'));
    } finally {
      await act(async () => root?.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });

  it('fences setters captured before reset and accepts the new version', () => {
    const key = questionDraftKey('agent-alpha', 'request-one');
    const staleVersion = getQuestionDraftVersion(key);
    useQuestionDraftStore.getState().setDraft(key, [answer('Before reset')], staleVersion);

    useQuestionDraftStore.getState().resetDraft(key);
    expect(getQuestionDraftVersion(key)).toBe(staleVersion + 1);
    useQuestionDraftStore.getState().setItem(key, 0, answer('Stale answer'), staleVersion);
    expect(getQuestionDraft(key)).toEqual([]);

    setItem(key, 0, answer('Current answer'));
    expect(getQuestionDraft(key)[0]).toEqual(answer('Current answer'));
  });

  it('fences an attachment-only question key during renderer cleanup', () => {
    const key = questionDraftKey('agent-alpha', 'request-one');
    const staleVersion = getQuestionDraftVersion(key);
    useComposerDraftStore.getState().appendFiles(key, [{
      id: 'file-one', name: 'sample.txt', path: '/sample/sample.txt',
    }]);

    clearAllConsoleDrafts();
    useQuestionDraftStore.getState().setItem(key, 0, answer('Stale answer'), staleVersion);

    expect(getQuestionDraftVersion(key)).toBe(staleVersion + 1);
    expect(getQuestionDraft(key)).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
  });

  it('reconciles to the exact pending identities and clears linked attachments', () => {
    const current = questionDraftKey('agent-alpha', 'request-current');
    const stale = questionDraftKey('agent-alpha', 'request-stale');
    const attachmentOnly = questionDraftKey('agent-alpha', 'request-attachment');
    const other = questionDraftKey('agent-beta', 'request-other');
    setItem(current, 0, answer('Current'));
    setItem(stale, 0, answer('Stale'));
    setItem(other, 0, answer('Other'));
    useComposerDraftStore.getState().appendFiles(current, [{
      id: 'file-current', name: 'current.txt', path: '/sample/current.txt',
    }]);
    useComposerDraftStore.getState().appendFiles(stale, [{
      id: 'file-stale', name: 'sample.txt', path: '/sample/sample.txt',
    }]);
    useComposerDraftStore.getState().appendFiles(attachmentOnly, [{
      id: 'file-attachment', name: 'attachment.txt', path: '/sample/attachment.txt',
    }]);

    reconcileQuestionDrafts([
      { agentId: 'agent-alpha', requestId: 'request-current' },
      { agentId: 'agent-beta', requestId: 'request-other' },
    ]);

    expect(getQuestionDraft(current)[0]?.custom).toBe('Current');
    expect(getQuestionDraft(other)[0]?.custom).toBe('Other');
    expect(getQuestionDraft(stale)).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[current]).toBeDefined();
    expect(useComposerDraftStore.getState().drafts[stale]).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts[attachmentOnly]).toBeUndefined();
  });

  it('aborts linked image capture when a question draft resets', () => {
    const key = questionDraftKey('agent-alpha', 'request-one');
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const composer = useComposerDraftStore.getState();
    useComposerDraftStore.setState({
      drafts: {
        ...composer.drafts,
        [key]: {
          text: '',
          edit: {},
          skills: [],
          browserEnvironmentIds: [],
          attachments: {
            files: [],
            images: [{
              id: 'image-one',
              name: 'sample.png',
              status: 'capturing',
              capture: { controller, done: new Promise<void>(() => undefined) },
            }],
          },
        },
      },
    });

    useQuestionDraftStore.getState().resetDraft(key);

    expect(abort).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
  });

  it('clears one agent independently, then clears all answers and attachments', () => {
    const first = questionDraftKey('agent-alpha', 'request-one');
    const second = questionDraftKey('agent-alpha', 'request-two');
    const other = questionDraftKey('agent-beta', 'request-one');
    for (const key of [first, second, other]) {
      setItem(key, 0, answer(`Answer for ${key}`));
      useComposerDraftStore.getState().appendFiles(key, [{
        id: `file-${key}`, name: 'sample.txt', path: `/sample/${key}.txt`,
      }]);
    }

    clearAgentQuestionDrafts('agent-alpha');
    expect(getQuestionDraft(first)).toEqual([]);
    expect(getQuestionDraft(second)).toEqual([]);
    expect(getQuestionDraft(other)).toHaveLength(1);
    expect(useComposerDraftStore.getState().drafts[first]).toBeUndefined();
    expect(useComposerDraftStore.getState().drafts[other]).toBeDefined();

    clearAllQuestionDrafts();
    expect(getQuestionDraft(other)).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[other]).toBeUndefined();
  });
});
