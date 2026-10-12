import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptProcessBoundaries } from '../../data/transcriptRows';
import {
  clearTranscriptPresentationMemory,
  mergeTranscriptProcessBoundaries,
  readTranscriptOpenGroups,
  readTranscriptProcessBoundaries,
  setTranscriptGroupOpen,
} from '../transcriptPresentationMemory';

const boundaries = (
  values: ReadonlyArray<readonly [string, string | null, string?]>,
): TranscriptProcessBoundaries => new Map(values.map(([groupId, endNodeId, finalTextNodeId]) => [
  groupId,
  { endNodeId, finalTextNodeId },
]));

beforeEach(clearTranscriptPresentationMemory);

describe('transcript presentation memory', () => {
  it('merges concurrent boundary commits without letting an older snapshot regress or remove groups', () => {
    const older = boundaries([['process:user-one', 'work-one']]);
    mergeTranscriptProcessBoundaries('target-main', older, ['user-one', 'work-one']);
    mergeTranscriptProcessBoundaries('target-main', boundaries([
      ['process:user-one', 'work-two', 'answer-two'],
      ['process:user-two', 'work-three'],
    ]), ['user-one', 'work-one', 'work-two', 'answer-two', 'user-two', 'work-three']);
    mergeTranscriptProcessBoundaries('target-main', new Map([[
      'process:user-one',
      { endNodeId: 'work-two', finalTextNodeId: 'answer-two', durationMs: 2000 },
    ]]), ['user-one', 'work-one', 'work-two', 'answer-two']);

    mergeTranscriptProcessBoundaries('target-main', older, ['user-one', 'work-one']);
    mergeTranscriptProcessBoundaries('target-main', new Map([[
      'process:user-one',
      { endNodeId: 'work-two', finalTextNodeId: 'answer-two', durationMs: 1000 },
    ]]), ['user-one', 'work-one', 'work-two', 'answer-two']);

    expect([...readTranscriptProcessBoundaries('target-main')!]).toEqual([
      ['process:user-one', { endNodeId: 'work-two', finalTextNodeId: 'answer-two', durationMs: 2000 }],
      ['process:user-two', { endNodeId: 'work-three', finalTextNodeId: undefined }],
    ]);
  });

  it.each(['work-one', null])('keeps a completed boundary fixed across later and stale commits (preceding work: %s)', (endNodeId) => {
    const original = new Map([['process:user-one', { endNodeId, finalTextNodeId: 'answer-one' }]]);
    mergeTranscriptProcessBoundaries('target-main', original, ['user-one', 'work-one', 'answer-one']);
    mergeTranscriptProcessBoundaries('target-main', new Map([
      ['process:user-one', { endNodeId: 'work-two', finalTextNodeId: 'answer-two' }],
      ['process:after:answer-one', { endNodeId: 'work-two', finalTextNodeId: 'answer-two' }],
    ]), ['user-one', 'work-one', 'answer-one', 'notice-one', 'work-two', 'answer-two']);
    mergeTranscriptProcessBoundaries('target-main', new Map([['process:user-one', null]]), ['user-one', 'work-one']);
    expect(readTranscriptProcessBoundaries('target-main')?.get('process:user-one')).toEqual(original.get('process:user-one'));
    expect(readTranscriptProcessBoundaries('target-main')?.get('process:after:answer-one')).toEqual({
      endNodeId: 'work-two', finalTextNodeId: 'answer-two',
    });
    mergeTranscriptProcessBoundaries('target-main', new Map([
      ['process:user-one', { endNodeId, finalTextNodeId: 'answer-one', durationMs: 2000 }],
    ]), ['user-one', 'work-one', 'answer-one']);
    expect(readTranscriptProcessBoundaries('target-main')?.get('process:user-one')).toEqual({
      endNodeId, finalTextNodeId: 'answer-one', durationMs: 2000,
    });
  });

  it('isolates targets and changes open groups only through explicit updates', () => {
    mergeTranscriptProcessBoundaries('target-main', boundaries([['process:user-one', 'work-one']]), ['work-one']);
    mergeTranscriptProcessBoundaries('target-worker', boundaries([['process:user-two', 'work-two']]), ['work-two']);
    setTranscriptGroupOpen('target-main', 'process:user-one', true);
    setTranscriptGroupOpen('target-main', 'tools:call-one', true);
    setTranscriptGroupOpen('target-main', 'process:user-one', false);

    expect(readTranscriptProcessBoundaries('target-main')?.has('process:user-one')).toBe(true);
    expect(readTranscriptProcessBoundaries('target-main')?.has('process:user-two')).toBe(false);
    expect([...readTranscriptOpenGroups('target-main')!]).toEqual(['tools:call-one']);
    expect([...readTranscriptOpenGroups('target-worker')!]).toEqual([]);
  });
});
