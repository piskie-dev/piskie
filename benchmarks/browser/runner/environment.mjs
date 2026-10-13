import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Source checkout identity. This does not claim that an attached application loaded this build. */
export async function collectEnvironment({ workspace, runner, browser = null, viewport = null, runtimeLabel = 'unknown', browserExecutable }) {
  const git = async (...args) => (await exec('git', args, { cwd: workspace, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const [revision, status, diff, untracked] = await Promise.all([
    git('rev-parse', 'HEAD'),
    git('status', '--porcelain=v1', '-z', '--untracked-files=all'),
    git('diff', '--binary', 'HEAD'),
    git('ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  const hash = createHash('sha256').update(diff);
  for (const filename of untracked.split('\0').filter(Boolean).sort()) {
    hash.update('\0').update(filename).update('\0').update(await readFile(resolve(workspace, filename)));
  }
  let browserExecutableSha256 = null;
  if (browserExecutable) {
    const binaryHash = createHash('sha256');
    for await (const chunk of createReadStream(browserExecutable)) binaryHash.update(chunk);
    browserExecutableSha256 = binaryHash.digest('hex');
  }
  return {
    revision: revision.trim(),
    dirty: status.length > 0,
    diffHash: hash.digest('hex'),
    node: process.version,
    platform: platform(),
    browser,
    browserExecutableSha256,
    viewport,
    runner,
    runtimeLabel,
  };
}
