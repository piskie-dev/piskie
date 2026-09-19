import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceBranch, readWorkspaceInfo, switchWorkspaceBranch } from '../capabilities/workspace.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const exec = promisify(execFile);
let root: string;
let repository: string;

async function git(...args: string[]) {
  const result = await exec('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: repository,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') },
  });
  return result.stdout.replace(/\n$/, '');
}

async function commit() {
  await writeFile(path.join(repository, 'sample.txt'), 'Initial sample\n');
  await git('add', 'sample.txt');
  await git('commit', '-m', 'Initial sample');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'workspace-git-test-'));
  repository = path.join(root, 'sample repository');
  await mkdir(repository);
  await git('init', '--initial-branch=main');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(stat).mockReset();
  await rm(root, { recursive: true, force: true });
});

describe('desktop workspace Git operations', () => {
  it.each(['ordinary', 'repository'] as const)('keeps an existing %s directory usable without Git and detects Git again after recovery', async (kind) => {
    const workspace = kind === 'repository' ? repository : path.join(root, 'ordinary folder');
    if (kind === 'ordinary') await mkdir(workspace);
    vi.stubEnv('PATH', root);

    await expect(readWorkspaceInfo(workspace)).resolves.toEqual({ path: workspace, git: null });
    await writeFile(path.join(workspace, 'sample.txt'), 'Available without Git\n');
    expect(await readFile(path.join(workspace, 'sample.txt'), 'utf8')).toBe('Available without Git\n');

    vi.unstubAllEnvs();
    const recovered = await readWorkspaceInfo(workspace);
    expect(recovered.error).toBeUndefined();
    if (kind === 'repository') expect(recovered.git?.head).toEqual({ kind: 'unborn', name: 'main' });
    else expect(recovered.git).toBeNull();
  });

  it('still reports a workspace removed after the directory check', async () => {
    const metadata = await stat(repository);
    await rm(repository, { recursive: true });
    const directoryCheck = vi.mocked(stat).mockClear().mockResolvedValueOnce(metadata);

    await expect(readWorkspaceInfo(repository)).resolves.toMatchObject({
      path: repository, git: null, error: expect.stringContaining('ENOENT'),
    });
    expect(directoryCheck).toHaveBeenCalledTimes(2);
  });

  it('preserves cancellation while Git is unavailable', async () => {
    const controller = new AbortController();
    const metadata = await stat(repository);
    vi.stubEnv('PATH', root);
    vi.mocked(stat).mockImplementationOnce(async () => {
      controller.abort(new Error('Workspace read cancelled'));
      return metadata;
    });

    await expect(readWorkspaceInfo(repository, controller.signal)).rejects.toThrow('Workspace read cancelled');
  });

  it('recognizes repository subdirectories and returns only existing local branches', async () => {
    await commit();
    await git('branch', 'feature/示例');
    await git('tag', 'main');
    await git('update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
    const nested = path.join(repository, 'nested folder');
    await mkdir(nested);
    expect(await readWorkspaceInfo(nested)).toEqual({
      path: nested,
      git: { root: repository, head: { kind: 'branch', name: 'main', commit: await git('rev-parse', 'HEAD') }, branches: ['feature/示例', 'main'], dirtyFileCount: 0 },
    });
    const result = await switchWorkspaceBranch(nested, 'feature/示例');
    expect(result.git?.head).toMatchObject({ kind: 'branch', name: 'feature/示例' });
    expect(result.path).toBe(nested);
    expect(await git('branch', '--show-current')).toBe('feature/示例');
  });

  it('preserves uncommitted edits when Git can carry them to an existing branch', async () => {
    await commit();
    const branch = 'feature/$(example);sample';
    await git('branch', branch);
    await writeFile(path.join(repository, 'sample.txt'), 'Uncommitted sample\n');
    const result = await switchWorkspaceBranch(repository, branch);
    expect(result.git?.head).toMatchObject({ kind: 'branch', name: branch });
    expect(await readFile(path.join(repository, 'sample.txt'), 'utf8')).toBe('Uncommitted sample\n');
    expect(await git('status', '--porcelain')).toContain('M sample.txt');
  });

  it('reports Git refusal and leaves the branch and conflicting edits intact', async () => {
    await commit();
    await git('switch', '-c', 'feature/change');
    await writeFile(path.join(repository, 'sample.txt'), 'Branch sample\n');
    await git('commit', '-am', 'Change sample');
    await git('switch', 'main');
    await writeFile(path.join(repository, 'sample.txt'), 'Uncommitted sample\n');
    await expect(switchWorkspaceBranch(repository, 'feature/change')).rejects.toThrow('would be overwritten');
    expect(await git('branch', '--show-current')).toBe('main');
    expect(await readFile(path.join(repository, 'sample.txt'), 'utf8')).toBe('Uncommitted sample\n');
  });

  it('reports unborn and detached HEAD and can switch from detached HEAD', async () => {
    expect((await readWorkspaceInfo(repository)).git).toMatchObject({ head: { kind: 'unborn', name: 'main' }, branches: [] });
    await commit();
    const commitId = await git('rev-parse', 'HEAD');
    await git('switch', '--detach', 'HEAD');
    expect((await readWorkspaceInfo(repository)).git?.head).toEqual({ kind: 'detached', commit: commitId });
    expect((await switchWorkspaceBranch(repository, 'main')).git?.head).toMatchObject({ kind: 'branch', name: 'main' });
  });

  it('distinguishes a created branch named (detached) from genuine detached HEAD at the same commit', async () => {
    await commit();
    const commitId = await git('rev-parse', 'HEAD');
    await writeFile(path.join(repository, 'sample.txt'), 'Uncommitted sample\n');
    const created = await createWorkspaceBranch(repository, '(detached)', (await readWorkspaceInfo(repository)).git!.head);
    expect(created.git?.head).toEqual({ kind: 'branch', name: '(detached)', commit: commitId });
    expect(created.git?.dirtyFileCount).toBe(1);
    expect(await git('symbolic-ref', '--quiet', 'HEAD')).toBe('refs/heads/(detached)');
    const next = await createWorkspaceBranch(repository, 'feature/next', created.git!.head);
    expect(next.git?.head).toEqual({ kind: 'branch', name: 'feature/next', commit: commitId });
    await git('switch', '--detach', 'refs/heads/(detached)');
    const detached = (await readWorkspaceInfo(repository)).git!;
    expect(detached.branches).toContain('(detached)');
    expect(detached.head).toEqual({ kind: 'detached', commit: commitId });
    const fromDetached = await createWorkspaceBranch(repository, 'feature/from-detached', detached.head);
    expect(fromDetached.git?.head).toEqual({ kind: 'branch', name: 'feature/from-detached', commit: commitId });
    expect(fromDetached.git?.dirtyFileCount).toBe(1);
  });

  it('creates and recognizes an unborn branch named (detached) and accepts it as the next creation base', async () => {
    await writeFile(path.join(repository, 'new.txt'), 'Staged sample\n'); await git('add', 'new.txt');
    const created = await createWorkspaceBranch(repository, '(detached)', (await readWorkspaceInfo(repository)).git!.head);
    expect(created.git).toMatchObject({ head: { kind: 'unborn', name: '(detached)' }, branches: [], dirtyFileCount: 1 });
    expect(await git('symbolic-ref', '--quiet', 'HEAD')).toBe('refs/heads/(detached)');
    expect((await readWorkspaceInfo(repository)).git?.head).toEqual({ kind: 'unborn', name: '(detached)' });
    const next = await createWorkspaceBranch(repository, 'feature/initial', created.git!.head);
    expect(next.git).toMatchObject({ head: { kind: 'unborn', name: 'feature/initial' }, dirtyFileCount: 1 });
    expect(await git('show', ':new.txt')).toBe('Staged sample');
  });

  it('recognizes linked worktrees and lets Git reject a branch already checked out elsewhere', async () => {
    await commit();
    const worktree = path.join(root, 'linked tree');
    await git('worktree', 'add', '-b', 'feature/linked', worktree);
    expect((await readWorkspaceInfo(worktree)).git).toMatchObject({ root: worktree, head: { kind: 'branch', name: 'feature/linked' } });
    await expect(switchWorkspaceBranch(repository, 'feature/linked')).rejects.toThrow(/already (used by worktree|checked out)/);
    expect(await git('branch', '--show-current')).toBe('main');
  });

  it('does not infer a remote branch or accept options and stale branch names', async () => {
    await commit();
    await git('update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
    for (const branch of ['remote-only', '--discard-changes', 'missing-branch']) {
      await expect(switchWorkspaceBranch(repository, branch)).rejects.toThrow('local branch no longer exists');
    }
    expect(await git('branch', '--show-current')).toBe('main');
    expect((await readWorkspaceInfo(repository)).git?.branches).toEqual(['main']);
  });

  it('counts the entire worktree once per porcelain entry, including unusual filenames and renamed files', async () => {
    const tracked = ['both states.txt', 'stage only.txt', 'unstaged 资料.txt', 'deleted.txt', '? source\n资料.txt', 'recreated 空白\nfile.txt'];
    await writeFile(path.join(repository, '.gitignore'), '*.ignored\n');
    for (const name of tracked) await writeFile(path.join(repository, name), `Sample ${name}\n`);
    await git('add', '.'); await git('commit', '-m', 'Sample files');
    await git('config', 'status.showUntrackedFiles', 'no');
    await git('config', 'status.renames', 'false');
    await writeFile(path.join(repository, tracked[0]!), 'Staged sample\n');
    await writeFile(path.join(repository, tracked[1]!), 'Staged sample\n');
    await git('add', tracked[0]!, tracked[1]!);
    await writeFile(path.join(repository, tracked[0]!), 'Unstaged sample\n');
    await writeFile(path.join(repository, tracked[2]!), 'Unstaged sample\n');
    await rm(path.join(repository, tracked[3]!));
    await git('mv', tracked[4]!, 'renamed 资料\nfile.txt');
    await git('rm', '--cached', tracked[5]!);
    const nested = path.join(repository, 'nested folder');
    await mkdir(nested);
    await writeFile(path.join(nested, 'first.txt'), 'New sample');
    await writeFile(path.join(nested, 'second 资料.txt'), 'New sample');
    await writeFile(path.join(repository, 'new\nline\t"资料.txt'), 'New sample');
    await writeFile(path.join(repository, 'skip.ignored'), 'Ignored sample');
    expect((await readWorkspaceInfo(nested)).git?.dirtyFileCount).toBe(9);
    expect((await readWorkspaceInfo(repository)).git?.dirtyFileCount).toBe(9);
  });

  it.skipIf(process.platform === 'win32')('keeps distinct non-UTF-8 filename bytes distinct when counting paths', async () => {
    await commit();
    for (const byte of [0xfe, 0xff]) {
      const file = Buffer.concat([Buffer.from(path.join(repository, 'raw-name-')), Buffer.from([byte])]);
      await writeFile(file, 'Untracked sample\n');
    }
    expect((await readWorkspaceInfo(repository)).git?.dirtyFileCount).toBe(2);
  });

  it('counts an unmerged file once and reports a modified submodule as one worktree entry', async () => {
    await commit();
    const linked = path.join(root, 'sample-submodule');
    await exec('git', ['clone', repository, linked]);
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', linked, 'modules/sample');
    await git('commit', '-am', 'Add sample module');
    await writeFile(path.join(repository, 'modules/sample/new.txt'), 'Untracked module sample');
    expect((await readWorkspaceInfo(repository)).git?.dirtyFileCount).toBe(1);
    await git('switch', '-c', 'feature/conflict');
    await writeFile(path.join(repository, 'sample.txt'), 'Feature sample\n');
    await git('commit', '-am', 'Feature sample');
    await git('switch', 'main');
    await writeFile(path.join(repository, 'sample.txt'), 'Main sample\n');
    await git('commit', '-am', 'Main sample');
    await expect(git('merge', 'feature/conflict')).rejects.toThrow();
    expect((await readWorkspaceInfo(repository)).git?.dirtyFileCount).toBe(2);
    await expect(createWorkspaceBranch(repository, 'feature/refused', (await readWorkspaceInfo(repository)).git!.head)).rejects.toThrow(/resolve|merging/);
    expect(await git('branch', '--show-current')).toBe('main');
    expect((await readWorkspaceInfo(repository)).git?.branches).not.toContain('feature/refused');
  });

  it('isolates dirty counts in linked worktrees and creates from a subdirectory without losing edits', async () => {
    await commit();
    const worktree = path.join(root, 'linked tree');
    await git('worktree', 'add', '-b', 'feature/linked', worktree);
    await writeFile(path.join(repository, 'sample.txt'), 'Main uncommitted sample\n');
    const nested = path.join(worktree, 'nested folder'); await mkdir(nested);
    await writeFile(path.join(worktree, 'sample.txt'), 'Linked uncommitted sample\n');
    await writeFile(path.join(nested, 'new.txt'), 'New sample\n');
    expect((await readWorkspaceInfo(repository)).git?.dirtyFileCount).toBe(1);
    const before = (await readWorkspaceInfo(nested)).git!;
    expect(before.dirtyFileCount).toBe(2);
    const created = await createWorkspaceBranch(nested, 'feature/linked-next', before.head);
    expect(created.git).toMatchObject({ head: { kind: 'branch', name: 'feature/linked-next' }, dirtyFileCount: 2 });
    expect(created.path).toBe(nested);
    expect(await readFile(path.join(worktree, 'sample.txt'), 'utf8')).toBe('Linked uncommitted sample\n');
    expect(await git('branch', '--show-current')).toBe('main');
  });

  it('creates and checks out a literal name at HEAD, preserving staged, unstaged and untracked changes', async () => {
    await commit();
    const before = (await readWorkspaceInfo(repository)).git!;
    await writeFile(path.join(repository, 'sample.txt'), 'Staged sample\n'); await git('add', 'sample.txt');
    await writeFile(path.join(repository, 'sample.txt'), 'Unstaged sample\n');
    await writeFile(path.join(repository, 'new.txt'), 'Untracked sample\n');
    const status = await git('status', '--porcelain=v2', '-z');
    const name = 'feature/$(example);示例';
    const created = await createWorkspaceBranch(repository, name, before.head);
    expect(created.git).toMatchObject({ head: { kind: 'branch', name }, dirtyFileCount: 2 });
    expect(created.git?.branches).toEqual([name, 'main']);
    expect(await git('branch', '--show-current')).toBe(name);
    expect(await git('rev-parse', 'HEAD')).toBe('commit' in before.head ? before.head.commit : undefined);
    expect(await git('status', '--porcelain=v2', '-z')).toBe(status);
    expect(await git('show', ':sample.txt')).toBe('Staged sample');
    expect(await readFile(path.join(repository, 'sample.txt'), 'utf8')).toBe('Unstaged sample\n');
  });

  it('creates from detached HEAD and from unborn HEAD without dropping staged files', async () => {
    await writeFile(path.join(repository, 'new.txt'), 'Sample\n'); await git('add', 'new.txt');
    const unborn = (await readWorkspaceInfo(repository)).git!;
    const initial = await createWorkspaceBranch(repository, 'feature/initial', unborn.head);
    expect(initial.git).toMatchObject({ head: { kind: 'unborn', name: 'feature/initial' }, branches: [], dirtyFileCount: 1 });
    expect(await git('show', ':new.txt')).toBe('Sample');
    await git('commit', '-m', 'Sample initial');
    await git('switch', '--detach', 'HEAD');
    const detached = (await readWorkspaceInfo(repository)).git!;
    const result = await createWorkspaceBranch(repository, 'feature/detached', detached.head);
    expect(result.git?.head).toEqual({ ...detached.head, kind: 'branch', name: 'feature/detached' });
    expect(result.git?.dirtyFileCount).toBe(0);
  });

  it('rejects duplicate, invalid and option-like names without changing HEAD, refs or edits', async () => {
    await commit();
    const base = (await readWorkspaceInfo(repository)).git!.head;
    await writeFile(path.join(repository, 'sample.txt'), 'Uncommitted sample\n');
    for (const name of ['main', 'invalid name', 'feature/../invalid', '--discard-changes', 'HEAD', '']) {
      await expect(createWorkspaceBranch(repository, name, base)).rejects.toThrow();
      expect(await git('branch', '--show-current')).toBe('main');
      expect((await readWorkspaceInfo(repository)).git?.branches).toEqual(['main']);
      expect(await readFile(path.join(repository, 'sample.txt'), 'utf8')).toBe('Uncommitted sample\n');
    }
    await git('switch', '-c', 'feature/previous'); await git('switch', 'main');
    await expect(createWorkspaceBranch(repository, '@{-1}', base)).rejects.toThrow('literal branch name');
  });

  it('rejects a changed or removed displayed base, then succeeds with the refreshed current HEAD', async () => {
    await commit();
    const base = (await readWorkspaceInfo(repository)).git!.head;
    await git('switch', '-c', 'feature/external');
    await git('branch', '-D', 'main');
    await expect(createWorkspaceBranch(repository, 'feature/new', base)).rejects.toMatchObject({ code: 'conflict' });
    expect(await git('branch', '--show-current')).toBe('feature/external');
    expect((await readWorkspaceInfo(repository)).git?.branches).toEqual(['feature/external']);
    const refreshed = (await readWorkspaceInfo(repository)).git!.head;
    await writeFile(path.join(repository, 'sample.txt'), 'External commit\n'); await git('commit', '-am', 'External sample');
    await expect(createWorkspaceBranch(repository, 'feature/new', refreshed)).rejects.toThrow('HEAD changed');
    const created = await createWorkspaceBranch(repository, 'feature/new', (await readWorkspaceInfo(repository)).git!.head);
    expect(created.git?.head).toMatchObject({ kind: 'branch', name: 'feature/new' });
    expect(await git('show', 'HEAD:sample.txt')).toBe('External commit');
  });

  it('distinguishes non-Git directories from unavailable directories and Git failures', async () => {
    const ordinary = path.join(root, 'ordinary folder');
    await mkdir(ordinary);
    expect(await readWorkspaceInfo(ordinary)).toEqual({ path: ordinary, git: null });
    await expect(switchWorkspaceBranch(ordinary, 'main')).rejects.toThrow('not a Git working tree');
    await expect(createWorkspaceBranch(ordinary, 'feature/new', { kind: 'unborn', name: 'main' })).rejects.toThrow('not a Git working tree');
    const missing = path.join(root, 'missing folder');
    expect(await readWorkspaceInfo(missing)).toMatchObject({ path: missing, git: null, error: expect.stringContaining('ENOENT') });
    const file = path.join(root, 'sample.txt');
    await writeFile(file, 'Sample');
    expect(await readWorkspaceInfo(file)).toMatchObject({ git: null, error: 'The workspace is not a directory' });
    await writeFile(path.join(repository, '.git', 'config'), '[invalid');
    expect(await readWorkspaceInfo(repository)).toMatchObject({ git: null, error: expect.stringContaining('bad config') });
    await expect(readWorkspaceInfo('relative-folder')).rejects.toThrow('absolute workspace path');
  });
});
