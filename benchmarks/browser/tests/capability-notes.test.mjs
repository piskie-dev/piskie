import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConsoleEvidence } from '../fixture/smoke.mjs';
import { buildReport } from '../reporting/index.mjs';

const baseRecord = () => ({
  schemaVersion: 1, suite: { id: 'browser-operations', version: '1' },
  runId: 'demo-console-run', scenarioId: 'diagnostics', seed: 1, attempt: 1,
  variant: 'demo', execution: 'scripted', startedAt: '2030-01-01T00:00:00.000Z',
  endedAt: '2030-01-01T00:00:01.000Z', wallTimeMs: 1000, termination: 'completed',
  environment: { revision: null, dirty: false, diffHash: null, node: 'v24.0.0', platform: 'linux',
    browser: 'Demo Chromium', viewport: { width: 1440, height: 1000 }, consoleEvidencePolicy: 'optional' },
  requestedModel: null,
  result: { status: 'passed', completedAt: '2030-01-01T00:00:01.000Z',
    checks: [{ id: 'resolution.saved', passed: true, expected: 1, actual: 1 }] },
});

test('console evidence stays strict unless the explicit fingerprint exception is enabled', () => {
  assert.throws(() => checkConsoleEvidence([]), /did not emit its console evidence/);
  assert.throws(() => checkConsoleEvidence([{ type: 'error', text: 'Connector DEMO_UNRELATED' }], true), /does not match/);
  assert.deepEqual(checkConsoleEvidence([{ type: 'error', text: 'Connector DEMO_ROUTE_RETIRED' }], true), []);
  const notes = checkConsoleEvidence([], true);
  assert.equal(notes[0].status, 'unavailable');
  assert.equal(notes[0].capability, 'console');
});

test('a waived console observation remains visible in reports and never waives failed business checks', () => {
  const record = baseRecord();
  record.capabilityNotes = checkConsoleEvidence([], true);
  const report = buildReport([record]);
  assert.equal(report.json.summary.overall.passed, 1);
  assert.match(report.markdown, /console observation unavailable/);
  assert.match(report.html, /console observation unavailable/);
  record.result.checks[0] = { id: 'resolution.saved', passed: false, expected: 1, actual: 0 };
  assert.equal(buildReport([record]).json.summary.overall.passed, 0);
});
