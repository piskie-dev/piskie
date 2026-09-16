import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceGitHead, WorkspaceGitInfo, WorkspaceInfo } from '../../../shared/electron-contracts/desktop.js';
import { PublicOperationError } from '../../capabilities/public-errors.js';

const execFileAsync = promisify(execFile);

async function git(workspace: string, args: string[], signal?: AbortSignal, encoding: 'utf8' | 'latin1' = 'utf8'): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspace,
    encoding,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    signal,
  });
  return stdout.replace(/\n$/, '');
}

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}

async function readGit(workspace: string, signal?: AbortSignal): Promise<WorkspaceGitInfo | null> {
  try {
    if (await git(workspace, ['rev-parse', '--is-inside-work-tree'], signal) !== 'true') return null;
  } catch (error) {
    if (gitError(error).startsWith('fatal: not a git repository')) return null;
    throw error;
  }
  const [root, refs, status] = await Promise.all([
    git(workspace, ['rev-parse', '--show-toplevel'], signal),
    git(workspace, ['for-each-ref', '--sort=refname', '--format=%(refname:strip=2)', 'refs/heads/'], signal),
    // Preserve filename bytes for deduplication; only the branch header needs UTF-8 decoding.
    git(workspace, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--no-ahead-behind',
      '-z', '--untracked-files=all', '--renames', '--ignore-submodules=none'], signal, 'latin1'),
  ]);
  const branches = refs ? refs.split('\n') : [];
  const entries = status.split('\0');
  let name = '';
  let commit = '';
  const dirtyPaths = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.startsWith('# branch.head ')) name = Buffer.from(entry.slice('# branch.head '.length), 'latin1').toString('utf8');
    else if (entry.startsWith('# branch.oid ')) commit = entry.slice('# branch.oid '.length);
    else if (['1', '2', 'u', '?'].includes(entry[0] ?? '')) {
      // Skip only the fixed metadata fields: the remaining path may contain spaces or newlines.
      const fields = entry[0] === '1' ? 8 : entry[0] === '2' ? 9 : entry[0] === 'u' ? 10 : 1;
      let pathOffset = 0;
      for (let field = 0; field < fields; field++) pathOffset = entry.indexOf(' ', pathOffset) + 1;
      // A staged deletion and an untracked replacement can report the same path twice.
      dirtyPaths.add(entry.slice(pathOffset));
      // Renames/copies append a source path; count only the destination.
      if (entry[0] === '2') index++;
    }
  }
  let detached = false;
  if (name === '(detached)') {
    // Porcelain uses a marker that is also a legal branch name, including for unborn HEAD.
    try {
      const ref = await git(workspace, ['symbolic-ref', '--quiet', 'HEAD'], signal);
      name = ref.replace(/^refs\/heads\//, '');
    } catch (error) {
      // symbolic-ref exits 1 only when HEAD is not symbolic; other failures remain read errors.
      if ((error as { code?: number }).code !== 1) throw error;
      detached = true;
    }
  }
  const head: WorkspaceGitHead = detached
    ? { kind: 'detached', commit }
    : commit === '(initial)' ? { kind: 'unborn', name } : { kind: 'branch', name, commit };
  return { root, head, branches, dirtyFileCount: dirtyPaths.size };
}

export async function readWorkspaceInfo(workspace: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
  if (!path.isAbsolute(workspace)) {
    throw new PublicOperationError('invalid-input', 'An absolute workspace path is required');
  }
  signal?.throwIfAborted();
  try {
    if (!(await stat(workspace)).isDirectory()) {
      throw new PublicOperationError('invalid-input', 'The workspace is not a directory');
    }
    return { path: workspace, git: await readGit(workspace, signal) };
  } catch (error) {
    signal?.throwIfAborted();
    return { path: workspace, git: null, error: gitError(error) };
  }
}

export async function switchWorkspaceBranch(workspace: string, branch: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
  const info = await readWorkspaceInfo(workspace, signal);
  if (info.error) throw new PublicOperationError('unavailable', info.error);
  if (!info.git) throw new PublicOperationError('invalid-input', 'The workspace is not a Git working tree');
  // The public input names an existing local ref; Git still checks concurrent changes at switch time.
  if (!info.git.branches.includes(branch)) {
    throw new PublicOperationError('not-found', 'The local branch no longer exists. Refresh the branch list.');
  }
  try {
    await git(workspace, ['switch', '--no-guess', '--', branch], signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PublicOperationError) throw error;
    throw new PublicOperationError('unavailable', gitError(error));
  }
  return readWorkspaceInfo(workspace, signal);
}

export async function createWorkspaceBranch(
  workspace: string, branch: string, base: WorkspaceGitHead, signal?: AbortSignal,
): Promise<WorkspaceInfo> {
  const info = await readWorkspaceInfo(workspace, signal);
  if (info.error) throw new PublicOperationError('unavailable', info.error);
  if (!info.git) throw new PublicOperationError('invalid-input', 'The workspace is not a Git working tree');
  const head = info.git.head;
  if (head.kind !== base.kind
    || ('name' in head && (!('name' in base) || head.name !== base.name))
    || ('commit' in head && (!('commit' in base) || head.commit !== base.commit))) {
    throw new PublicOperationError('conflict', 'HEAD changed since the form was displayed. Review the refreshed base and try again.');
  }
  try {
    const checkedName = await git(workspace, ['check-ref-format', '--branch', branch], signal);
    // --branch expands checkout shortcuts such as @{-1}; creation accepts literal names only.
    if (checkedName !== branch) {
      throw new PublicOperationError('invalid-input', 'Use a literal branch name, not a checkout shortcut.');
    }
    // Pin the accepted commit so a later external HEAD change cannot silently change the base.
    // Git can also switch -c from an unborn HEAD, preserving its index and working files.
    await git(workspace, ['switch', '--no-guess', '--no-track', '-c', branch,
      ...(head.kind === 'unborn' ? [] : ['--', head.commit])], signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PublicOperationError) throw error;
    throw new PublicOperationError('unavailable', gitError(error));
  }
  return readWorkspaceInfo(workspace, signal);
}
