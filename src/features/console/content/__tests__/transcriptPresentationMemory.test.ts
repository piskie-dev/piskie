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
