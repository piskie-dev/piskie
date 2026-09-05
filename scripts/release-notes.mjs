import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const reviewRoot = path.join(projectRoot, 'release', 'review');
const templatePath = path.join(projectRoot, '.github', 'release-notes', 'template.md');
const repository = 'piskie-dev/piskie';
const schemaVersion = 1;
const releaseKeys = [
  'schemaVersion',
  'version',
  'targetCommit',
  'summary',
  'newFeatures',
  'improvements',
  'bugFixes',
];
const sections = [
  ['newFeatures', 'New Features'],
  ['improvements', 'Improvements'],
  ['bugFixes', 'Bug Fixes'],
];

export function validateReleaseContent(content, expectedVersion, expectedTargetCommit) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Release content must be a JSON object');
  }

  const keys = Object.keys(content).sort();
  const expectedKeys = [...releaseKeys].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Release content fields must be exactly: ${releaseKeys.join(', ')}`);
  }
  if (content.schemaVersion !== schemaVersion) {
    throw new Error(`Release content schemaVersion must be ${schemaVersion}`);
  }
  if (content.version !== expectedVersion) {
    throw new Error(`Release content version must be ${expectedVersion}`);
  }
  if (typeof content.targetCommit !== 'string' || !/^[a-f0-9]{40}$/.test(content.targetCommit)) {
    throw new Error('Release content targetCommit must be a full Git commit SHA');
  }
  if (expectedTargetCommit && content.targetCommit !== expectedTargetCommit) {
    throw new Error(
      `Release content targetCommit ${content.targetCommit} does not match analyzed commit ${expectedTargetCommit}`
    );
  }

  const summary = validateLine(content.summary, 'summary', 240);
  const normalized = {
    schemaVersion,
    version: expectedVersion,
    targetCommit: content.targetCommit,
    summary,
  };

  let changeCount = 0;
  for (const [key] of sections) {
    const values = content[key];
    if (!Array.isArray(values)) {
      throw new Error(`${key} must be an array`);
    }
    normalized[key] = values.map((value, index) => validateLine(value, `${key}[${index}]`, 300));
    changeCount += normalized[key].length;
  }

  if (changeCount === 0) {
    throw new Error('Release content must contain at least one change');
  }
  if (changeCount > 8) {
    throw new Error('Release content must contain no more than 8 changes');
  }

  return normalized;
}

export function renderReleaseNotes(content, template) {
  const normalized = validateReleaseContent(content, content?.version);
  const changeSections = sections
    .filter(([key]) => normalized[key].length > 0)
    .map(([key, heading]) =>
      [`## ${heading}`, '', ...normalized[key].map((item) => `- ${item}`)].join('\n')
    )
    .join('\n\n');

  const rendered = template
    .replace('{{summary}}', normalized.summary)
    .replace('{{change_sections}}', changeSections)
    .trim();

  if (/{{[^{}]+}}/.test(rendered)) {
    throw new Error('Release template contains an unknown placeholder');
  }
  return `${rendered}\n`;
}

export function releaseNotesDigest(notes) {
  return createHash('sha256').update(notes, 'utf8').digest('hex');
}

async function prepare(tag, args) {
  const { target } = parsePrepareArgs(args);
  const targetCommit = run('git', ['rev-parse', '--verify', `${target}^{commit}`]);
  const targetPackageMetadata = JSON.parse(run('git', ['show', `${targetCommit}:package.json`]));
  const version = validateTag(tag, targetPackageMetadata.version);
  const previousTag = findPreviousTag(tag, targetCommit);
  const baseCommit = previousTag
    ? run('git', ['rev-parse', '--verify', `${previousTag}^{commit}`])
    : run('git', ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
  const revisionRange = previousTag ? `${previousTag}..${targetCommit}` : targetCommit;
  const commitShas = lines(run('git', ['rev-list', '--reverse', revisionRange]));
  const commits = commitShas.map((sha) => ({
    sha,
    subject: run('git', ['show', '-s', '--format=%s', sha]),
    body: run('git', ['show', '-s', '--format=%b', sha]),
  }));
  const pullRequestNumbers = findPullRequestNumbers(commits);
  const pullRequests = pullRequestNumbers.map((number) => readPullRequest(number)).filter(Boolean);
  const changedFiles = lines(
    run('git', ['diff', '--name-status', '--find-renames', baseCommit, targetCommit])
  ).map(parseChangedFile);

  const directory = releaseDirectory(version);
  await fs.mkdir(directory, { recursive: true });
  const contextPath = path.join(directory, 'context.json');
  const contentPath = path.join(directory, 'content.json');
  await writeJson(contextPath, {
    schemaVersion,
    tag,
    version,
    target: { ref: target, commit: targetCommit },
    previousTag,
    comparison: { from: baseCommit, to: targetCommit },
    commits,
    pullRequests,
    changedFiles,
  });

  if (!(await exists(contentPath))) {
    await writeJson(contentPath, {
      schemaVersion,
      version,
      targetCommit,
      summary: '',
      newFeatures: [],
      improvements: [],
      bugFixes: [],
    });
  } else {
    const existingContent = await readJson(contentPath);
    if (existingContent.targetCommit !== targetCommit) {
      console.warn(
        `Existing release content targets ${existingContent.targetCommit ?? 'an unknown commit'}; re-review it for ${targetCommit}.`
      );
    }
  }

  console.log(`Release context: ${relative(contextPath)}`);
  console.log(`Release content: ${relative(contentPath)}`);
  console.log(
    `Collected ${commits.length} commits, ${pullRequests.length} pull requests, and ${changedFiles.length} changed files.`
  );
}

async function render(tag, args) {
  assertNoArgs(args, 'render');
  const packageMetadata = await readPackageMetadata();
  const version = validateTag(tag, packageMetadata.version);
  const directory = releaseDirectory(version);
  const context = await readJson(path.join(directory, 'context.json'));
  if (context.version !== version || !/^[a-f0-9]{40}$/.test(context.target?.commit ?? '')) {
    throw new Error('Release context is missing or does not match the requested version');
  }
  const content = await readJson(path.join(directory, 'content.json'));
  const template = await fs.readFile(templatePath, 'utf8');
  const normalized = validateReleaseContent(content, version, context.target.commit);
  const notes = renderReleaseNotes(normalized, template);
  const notesPath = path.join(directory, 'release-notes.md');
  await fs.writeFile(notesPath, notes, 'utf8');
  console.log(`Release notes: ${relative(notesPath)}`);
  const digest = releaseNotesDigest(notes);
  console.log(`Review SHA-256: ${digest}`);
  return { notesPath, digest, targetCommit: normalized.targetCommit };
}

async function upload(tag, args) {
  if (args.length !== 2 || args[0] !== '--reviewed-sha256' || !/^[a-f0-9]{64}$/i.test(args[1])) {
    throw new Error('Upload requires --reviewed-sha256 SHA256 for the approved rendered notes');
  }
  const approvedDigest = args[1].toLowerCase();
  const { notesPath, digest, targetCommit } = await render(tag, []);
  if (digest !== approvedDigest) {
    throw new Error(
      `Release notes changed after review: expected ${approvedDigest}, rendered ${digest}`
    );
  }
  let taggedCommit;
  try {
    taggedCommit = run('git', ['rev-parse', '--verify', `${tag}^{commit}`]);
  } catch (error) {
    throw new Error(`Local tag ${tag} is required before upload: ${error.message}`);
  }
  if (taggedCommit !== targetCommit) {
    throw new Error(`Tag ${tag} points to ${taggedCommit}, but the notes describe ${targetCommit}`);
  }
  let release;
  try {
    release = JSON.parse(
      run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'isDraft,tagName,url'])
    );
  } catch (error) {
    throw new Error(`An existing Draft Release is required before upload: ${error.message}`);
  }
  if (release.tagName !== tag) {
    throw new Error(`Draft Release tag ${release.tagName ?? 'missing'} does not match ${tag}`);
  }
  if (!release.isDraft) {
    throw new Error(`Release ${tag} is already published and cannot be updated by this command`);
  }

  run('gh', ['release', 'edit', tag, '--repo', repository, '--notes-file', notesPath]);
  console.log(`Draft Release updated: ${release.url}`);
}

async function main() {
  const [command, tag, ...args] = process.argv.slice(2);
  if (!command || !tag || !['prepare', 'render', 'upload'].includes(command)) {
    throw new Error(
      'Usage: npm run release:notes -- <prepare|render|upload> vMAJOR.MINOR.PATCH [options]'
    );
  }

  if (command === 'prepare') await prepare(tag, args);
  if (command === 'render') await render(tag, args);
  if (command === 'upload') await upload(tag, args);
}

function parsePrepareArgs(args) {
  if (args.length === 0) return { target: 'HEAD' };
  if (args.length === 2 && args[0] === '--target' && args[1]) return { target: args[1] };
  throw new Error('Prepare accepts only an optional --target TARGET_REF');
}

function assertNoArgs(args, command) {
  if (args.length > 0) throw new Error(`${command} does not accept additional arguments`);
}

function validateTag(tag, packageVersion) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? '');
  if (!match) throw new Error(`Release tag must be vMAJOR.MINOR.PATCH: ${tag ?? 'missing'}`);
  const version = tag.slice(1);
  if (version !== packageVersion) {
    throw new Error(`Release tag ${tag} does not match package version v${packageVersion}`);
  }
  return version;
}

function validateLine(value, field, maxLength) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (/\r|\n/.test(normalized)) throw new Error(`${field} must be a single line`);
  if (normalized.length > maxLength)
    throw new Error(`${field} must be at most ${maxLength} characters`);
  if (normalized.startsWith('- '))
    throw new Error(`${field} must not include a Markdown bullet prefix`);
  return normalized;
}

function findPreviousTag(currentTag, targetCommit) {
  const currentVersion = parseVersion(currentTag);
  return (
    lines(run('git', ['tag', '--merged', targetCommit, '--list', 'v*']))
      .filter((tag) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag))
      .filter((tag) => compareVersions(parseVersion(tag), currentVersion) < 0)
      .sort((left, right) => compareVersions(parseVersion(right), parseVersion(left)))[0] ?? null
  );
}

function parseVersion(tag) {
  return tag.slice(1).split('.').map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function findPullRequestNumbers(commits) {
  const numbers = new Set();
  for (const commit of commits) {
    const message = `${commit.subject}\n${commit.body}`;
    for (const match of message.matchAll(/(?:pull request #|\(#)(\d+)\)?/gi)) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function readPullRequest(number) {
  const result = tryRun('gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    repository,
    '--json',
    'number,title,body,labels,mergedAt,url',
  ]);
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function parseChangedFile(line) {
  const [status, ...paths] = line.split('\t');
  return { status, paths };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function tryRun(command, args) {
  try {
    return run(command, args);
  } catch {
    return null;
  }
}

function lines(value) {
  return value ? value.split('\n').filter(Boolean) : [];
}

function releaseDirectory(version) {
  return path.join(reviewRoot, version);
}

async function readPackageMetadata() {
  return readJson(path.join(projectRoot, 'package.json'));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function exists(filePath) {
  return fs
    .stat(filePath)
    .then((stats) => stats.isFile())
    .catch(() => false);
}

function relative(filePath) {
  return path.relative(projectRoot, filePath);
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
