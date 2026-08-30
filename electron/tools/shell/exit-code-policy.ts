export type ExitClassification = Readonly<{ ok: boolean; note?: string }>;

/** Shell exit semantics, including the useful non-error exit code 1 cases. */
export function classifyExit(command: string, exitCode: number): ExitClassification {
  if (exitCode === 0) return { ok: true };
  if (exitCode === 1 && isNoMatchCommand(command)) {
    return { ok: true, note: 'No matches found' };
  }
  if (exitCode === 1 && isDiffCommand(command)) {
    return { ok: true, note: 'Files differ' };
  }
  return { ok: false };
}

function isNoMatchCommand(command: string): boolean {
  return commandSegments(command).some((segment) => (
    /^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:grep|rg|egrep|fgrep)\b/u.test(segment)
    || /^(?:\w+=\S+\s+)*(?:sudo\s+)?git\s+(?:-[^\s]+\s+)*grep\b/u.test(segment)
  ));
}

function isDiffCommand(command: string): boolean {
  return commandSegments(command).some((segment) => (
    /^(?:\w+=\S+\s+)*(?:sudo\s+)?diff\b/u.test(segment)
    || /^(?:\w+=\S+\s+)*(?:sudo\s+)?git\s+(?:-[^\s]+\s+)*diff\b/u.test(segment)
  ));
}

function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}
