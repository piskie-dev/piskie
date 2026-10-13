import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecords } from '../cli.mjs';

const record = { schemaVersion: 1, runId: 'demo-run', scenarioId: 'intake' };

test('run-directory ingestion chooses raw records once and does not ingest report copies or browser profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-report-input-'));
  try {
    await mkdir(join(root, 'records'));
    await mkdir(join(root, 'profile'));
    await writeFile(join(root, 'records', 'demo-run.json'), JSON.stringify(record));
    await writeFile(join(root, 'report.json'), JSON.stringify({ records: [record] }));
    await writeFile(join(root, 'profile', 'Preferences'), '{}');
    assert.deepEqual(await readRecords(root), [record]);
    assert.deepEqual(await readRecords(join(root, 'report.json')), [record]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSONL input retains separate failed attempts and rejects files that are not benchmark records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-report-jsonl-'));
  try {
    const failed = { ...record, runId: 'demo-failed', termination: 'timeout' };
    await writeFile(join(root, 'attempts.jsonl'), `${JSON.stringify(record)}\n\n${JSON.stringify(failed)}\n`);
    assert.deepEqual(await readRecords(join(root, 'attempts.jsonl')), [record, failed]);
    await writeFile(join(root, 'unrelated.json'), '{"other":"data"}');
    await assert.rejects(readRecords(join(root, 'unrelated.json')), /Expected benchmark records/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
