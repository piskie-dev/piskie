import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  releaseNotesDigest,
  renderReleaseNotes,
  validateReleaseContent,
} from './release-notes.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const template = await fs.readFile(
  path.join(projectRoot, '.github', 'release-notes', 'template.md'),
  'utf8'
);

function releaseContent(overrides = {}) {
  return {
    schemaVersion: 1,
    version: '1.2.3',
    targetCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    summary: 'This release improves everyday desktop workflows.',
    newFeatures: ['Added a reusable workspace view.'],
    improvements: [],
    bugFixes: ['Fixed an update prompt that could show the wrong version.'],
    ...overrides,
  };
}

test('renders only populated change sections with the fixed notice', () => {
  const notes = renderReleaseNotes(releaseContent(), template);

  assert.match(notes, /^This release improves everyday desktop workflows\./);
  assert.match(notes, /## New Features\n\n- Added a reusable workspace view\./);
  assert.doesNotMatch(notes, /## Improvements/);
  assert.match(notes, /## Bug Fixes\n\n- Fixed an update prompt/);
  assert.match(notes, /\*\*Windows notice:\*\* The installer is currently unsigned/);
  assert.doesNotMatch(notes, /## Downloads/);
});

test('rejects fields outside the release content contract', () => {
  assert.throws(
    () => validateReleaseContent(releaseContent({ downloads: [] }), '1.2.3'),
    /fields must be exactly/
  );
});

test('requires at least one change and limits the public list', () => {
  assert.throws(
    () => validateReleaseContent(releaseContent({ newFeatures: [], bugFixes: [] }), '1.2.3'),
    /at least one change/
  );
  assert.throws(
    () =>
      validateReleaseContent(
        releaseContent({
          newFeatures: Array.from({ length: 9 }, (_, index) => `Added capability ${index + 1}.`),
          bugFixes: [],
        }),
        '1.2.3'
      ),
    /no more than 8 changes/
  );
});

test('requires the content version to match the requested release', () => {
  assert.throws(() => validateReleaseContent(releaseContent(), '2.0.0'), /version must be 2\.0\.0/);
});

test('binds release content to the analyzed commit', () => {
  assert.throws(
    () =>
      validateReleaseContent(releaseContent(), '1.2.3', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    /does not match analyzed commit/
  );
});

test('produces a stable review digest for the exact rendered notes', () => {
  const notes = renderReleaseNotes(releaseContent(), template);

  assert.equal(releaseNotesDigest(notes), releaseNotesDigest(notes));
  assert.notEqual(releaseNotesDigest(notes), releaseNotesDigest(`${notes}\n`));
});
