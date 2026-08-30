import { createTwoFilesPatch, structuredPatch } from 'diff';

export type DiffStat = Readonly<{
  linesAdded: number;
  linesDeleted: number;
  linesChanged: number;
}>;

export type FileDiff = Readonly<{
  unifiedDiff: string;
  stat: DiffStat;
}>;

export function unifiedDiff(filePath: string, oldContent: string, newContent: string): FileDiff {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, '', '');
  let added = 0;
  let deleted = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      if (line.startsWith('-')) deleted++;
    }
  }
  const changed = Math.min(added, deleted);
  return {
    unifiedDiff: createTwoFilesPatch(
      `a/${filePath}`,
      `b/${filePath}`,
      oldContent,
      newContent,
      '',
      '',
      { context: 3 },
    ),
    stat: {
      linesAdded: added - changed,
      linesDeleted: deleted - changed,
      linesChanged: changed,
    },
  };
}

export function formatDiffStat(stat: DiffStat): string {
  const parts = [
    stat.linesAdded > 0 ? `+${stat.linesAdded}` : '',
    stat.linesDeleted > 0 ? `-${stat.linesDeleted}` : '',
    stat.linesChanged > 0 ? `~${stat.linesChanged}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'no changes';
}
