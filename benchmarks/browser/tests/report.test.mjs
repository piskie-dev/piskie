import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { runInNewContext } from 'node:vm';
import { validateRecord, summarizeRecords, buildReport, writeReport } from '../reporting/index.mjs';

const coverage = () => ({ toolTiming: 'complete', firstToken: 'complete', throughput: 'complete', inputTokens: 'complete', outputTokens: 'complete', cacheReadTokens: 'complete' });
function metrics(overrides = {}) {
  return {
    version: 1, rounds: 2, steps: 4, llmDurationMs: 1500, toolDurationMs: 300,
    firstTokenLatencyTotalMs: 200, firstTokenSamples: 2,
    throughputDurationMs: 1000, throughputOutputTokens: 100,
    inputTokens: 200, outputTokens: 100, cacheReadTokens: 0,
    ...overrides, coverage: { ...coverage(), ...overrides.coverage },
  };
}
function agent(overrides = {}) {
  return { agentId: 'agent-primary', parentAgentId: null, agentType: 'coordinator', currentModel: 'model-alpha', runMetrics: metrics(), ...overrides };
}
function record(overrides = {}) {
  return {
    schemaVersion: 1, suite: { id: 'browser-operations', version: '1' },
    runId: 'run-example', scenarioId: 'form-workflow', seed: 7, attempt: 1, variant: 'candidate', execution: 'model',
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:05.000Z', wallTimeMs: 5000,
    termination: 'completed',
    environment: {
      revision: 'revision-candidate', dirty: true, diffHash: 'hash-candidate',
      node: 'v24.0.0', platform: 'linux', browser: 'ExampleBrowser/1', viewport: { width: 1280, height: 800 },
      runtimeLabel: 'candidate-build', arch: 'example-architecture',
    },
    requestedModel: 'model-requested', agents: [agent()],
    result: { status: 'passed', checks: [{ id: 'saved-values', passed: true, expected: { saved: true }, actual: { saved: true } }], completedAt: '2026-01-01T00:00:04.000Z' },
    ...overrides,
  };
}
function scripted(overrides = {}) {
  const value = record({ execution: 'scripted', ...overrides });
  delete value.agents;
  delete value.requestedModel;
  return value;
}
function baseline(overrides = {}) {
  const value = record({ runId: 'run-baseline', variant: 'baseline', ...overrides });
  value.environment = { ...value.environment, revision: 'revision-baseline', dirty: false, diffHash: null, runtimeLabel: 'baseline-build', ...overrides.environment };
  return value;
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// All records below are synthetic contract examples, never benchmark measurements.
test('validates the public record while preserving additional JSON metadata', () => {
  const value = record({ annotations: { note: 'synthetic example' } });
  assert.deepEqual(validateRecord(value), { valid: true, errors: [], warnings: [] });
  assert.equal(validateRecord(scripted()).valid, true);
  assert.equal(validateRecord(record({ agents: [] })).valid, true);
  assert.equal(validateRecord(record({ agents: [agent({ runMetrics: null })] })).valid, true);
  assert.equal(validateRecord(record({ environment: { ...value.environment, browser: null, viewport: null } })).valid, true);
});

test('rejects malformed external metrics and reports field paths instead of dropping records', () => {
  const cases = [
    [record({ schemaVersion: 2 }), 'schemaVersion'],
    [record({ wallTimeMs: -1 }), 'wallTimeMs'],
    [record({ attempt: 0 }), 'attempt'],
    [record({ endedAt: '2025-01-01T00:00:00Z' }), 'endedAt'],
    [record({ agents: [agent({ runMetrics: metrics({ steps: 0.5 }) })] }), 'steps'],
    [record({ agents: [agent({ runMetrics: metrics({ throughputDurationMs: Infinity }) })] }), 'throughputDurationMs'],
    [record({ agents: [agent({ runMetrics: metrics({ coverage: { outputTokens: 'unknown' } }) })] }), 'coverage.outputTokens'],
    [record({ agents: [agent({ modelsObserved: ['model-beta'] })] }), 'modelsObserved'],
    [record({ toolCalls: { total: 1, browser: 2, failed: 0 } }), 'toolCalls.browser'],
    [record({ agents: [agent(), agent()] }), 'agentId'],
    [record({ agents: [agent({ parentAgentId: 'agent-primary' })] }), 'cycle'],
  ];
  for (const [value, field] of cases) {
    const result = validateRecord(value);
    assert.equal(result.valid, false, field);
    assert.ok(result.errors.some((error) => error.includes(field)), result.errors.join('\n'));
    assert.throws(() => summarizeRecords([value]), /records\[0\]/);
  }
  const circular = record();
  circular.extra = circular;
  assert.ok(validateRecord(circular).errors.some((error) => error.includes('circular')));
  assert.throws(() => buildReport([], { baselineRecords: [record({ wallTimeMs: -1 })] }), /baselineRecords\[0\]/);
});

test('weights throughput by paired full-attempt duration and TTFT by measured samples', () => {
  const rows = [
    record({ agents: [agent({ runMetrics: metrics({ outputTokens: 900, throughputOutputTokens: 100, throughputDurationMs: 1000, firstTokenLatencyTotalMs: 100, firstTokenSamples: 1 }) })] }),
    record({ runId: 'run-second', agents: [agent({ runMetrics: metrics({ outputTokens: 800, throughputOutputTokens: 100, throughputDurationMs: 9000, firstTokenLatencyTotalMs: 900, firstTokenSamples: 3, llmDurationMs: 20000 }) })] }),
  ];
  const summary = summarizeRecords(rows);
  assert.equal(summary.overall.metrics.throughput.tokensPerSecond, 20);
  assert.equal(summary.byModel[0].metrics.throughput.tokensPerSecond, 20);
  assert.equal(summary.overall.metrics.throughput.pairedOutputTokens, 200);
  assert.equal(summary.overall.metrics.throughput.pairedDurationMs, 10000);
  assert.equal(summary.overall.metrics.outputTokens.total, 1700);
  assert.equal(summary.overall.metrics.firstToken.meanMs, 250);
  assert.equal(summary.overall.metrics.firstToken.samples, 4);
});

test('missing pairs are never reconstructed from output tokens, LLM time or wall time', () => {
  const rows = [
    record(),
    record({ runId: 'run-missing', agents: [agent({ runMetrics: metrics({ outputTokens: 800, throughputOutputTokens: 0, throughputDurationMs: 0, coverage: { throughput: 'none' } }) })] }),
    record({ runId: 'run-partial', agents: [agent({ runMetrics: metrics({ throughputOutputTokens: 20, throughputDurationMs: 500, coverage: { throughput: 'partial' } }) })] }),
  ];
  const value = summarizeRecords(rows).overall.metrics.throughput;
  assert.equal(value.tokensPerSecond, 80);
  assert.equal(value.pairedOutputTokens, 120);
  assert.equal(value.pairedDurationMs, 1500);
  assert.equal(value.coverage, 'partial');
  assert.equal(value.observed, 2);
  assert.equal(value.totalSamples, 3);
  const missing = summarizeRecords([rows[1]]).overall.metrics.throughput;
  assert.equal(missing.tokensPerSecond, null);
  assert.equal(missing.pairedOutputTokens, null);
});

test('distinguishes measured zero from unavailable tokens, TTFT and zero-duration rates', () => {
  const zero = record({ agents: [agent({ runMetrics: metrics({ throughputOutputTokens: 0, outputTokens: 0, inputTokens: 0, firstTokenLatencyTotalMs: 0 }) })] });
  const known = summarizeRecords([zero]).overall.metrics;
  assert.equal(known.throughput.tokensPerSecond, 0);
  assert.equal(known.firstToken.meanMs, 0);
  assert.equal(known.inputTokens.total, 0);
  assert.equal(known.cacheReadTokens.total, 0);
  const missing = record({ agents: [agent({ runMetrics: metrics({
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    throughputDurationMs: 0, firstTokenSamples: 0,
    coverage: { inputTokens: 'none', outputTokens: 'none', cacheReadTokens: 'none' },
  }) })] });
  const absent = summarizeRecords([missing]).overall.metrics;
  assert.equal(absent.inputTokens.total, null);
  assert.equal(absent.outputTokens.total, null);
  assert.equal(absent.cacheReadTokens.total, null);
  assert.equal(absent.throughput.tokensPerSecond, null);
  assert.equal(absent.firstToken.meanMs, null);
  assert.ok(validateRecord(missing).warnings.some((item) => item.includes('zero paired')));
  assert.match(buildReport([missing]).markdown, /N\/A/);
});

test('attributes actual parent and browser models separately and does not use requestedModel', () => {
  const value = record({ agents: [
    agent({ runMetrics: metrics({ steps: 3 }) }),
    agent({ agentId: 'agent-browser', parentAgentId: 'agent-primary', agentType: 'browser-worker', currentModel: 'model-beta', runMetrics: metrics({ steps: 8, throughputOutputTokens: 400, throughputDurationMs: 2000 }) }),
  ], toolCalls: { total: 11, browser: 7, failed: 2 } });
  const summary = summarizeRecords([value]);
  assert.equal(summary.overall.metrics.steps.total, 11);
  assert.equal(summary.overall.metrics.throughput.tokensPerSecond, null);
  assert.equal(summary.overall.metrics.toolCalls.browser.total, 7);
  assert.equal(summary.overall.metrics.toolCalls.failed.total, 2);
  const parent = summary.byModel.find((row) => row.model === 'model-alpha');
  const browser = summary.byModel.find((row) => row.model === 'model-beta');
  assert.equal(parent.metrics.throughput.tokensPerSecond, 100);
  assert.equal(browser.metrics.throughput.tokensPerSecond, 200);
  assert.deepEqual(browser.role, ['coordinator', 'browser-worker']);
  assert.equal(browser.metrics.steps.mean, 8);
  assert.equal(summary.byModel.some((row) => row.model === value.requestedModel), false);
});

test('does not pool rates across different actual models in different runs', () => {
  const summary = summarizeRecords([record(), record({ runId: 'run-other', agents: [agent({ currentModel: 'model-beta' })] })]);
  assert.equal(summary.overall.metrics.throughput.tokensPerSecond, null);
  assert.equal(summary.byScenario[0].metrics.throughput.tokensPerSecond, null);
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.groups.length, 2);
  assert.ok(summary.byModel.every((row) => row.metrics.throughput.tokensPerSecond === 100));
});

test('preserves a model change as a model set without assigning cumulative tokens to the last model', () => {
  const value = record({ agents: [agent({ currentModel: 'model-beta', modelsObserved: ['model-beta', 'model-alpha', 'model-beta'] })] });
  const summary = summarizeRecords([value]);
  assert.equal(summary.byModel.length, 1);
  const row = summary.byModel[0];
  assert.equal(row.model, null);
  assert.equal(row.attribution, 'multiple');
  assert.deepEqual(row.modelsObserved, ['model-alpha', 'model-beta']);
  assert.equal(row.metrics.throughput.tokensPerSecond, null);
  assert.equal(row.metrics.outputTokens.total, 100);
  assert.deepEqual(value.agents[0].modelsObserved, ['model-beta', 'model-alpha', 'model-beta']);
  const unknown = summarizeRecords([record({ agents: [agent({ currentModel: null })] })]);
  assert.equal(unknown.byModel[0].attribution, 'unknown');
  assert.equal(unknown.byModel[0].metrics.throughput.tokensPerSecond, null);
});

test('counts failed, timed-out and cancelled attempts in pass and wall statistics', () => {
  const fail = { status: 'failed', checks: [{ id: 'saved-values', passed: false, expected: 3, actual: 2 }], completedAt: null };
  const rows = [
    record({ wallTimeMs: 10 }),
    record({ runId: 'run-failed', wallTimeMs: 20, termination: 'failed', result: fail }),
    record({ runId: 'run-timeout', wallTimeMs: 1000, termination: 'timeout' }),
    record({ runId: 'run-cancelled', wallTimeMs: 2000, termination: 'cancelled', result: fail }),
  ];
  const result = summarizeRecords(rows).overall;
  assert.equal(result.attempts, 4);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 3);
  assert.equal(result.passRate, 0.25);
  assert.deepEqual(result.terminations, { completed: 1, failed: 1, timeout: 1, cancelled: 1 });
  assert.equal(result.wallTimeMs.median, 510);
  assert.equal(result.wallTimeMs.p95, 2000);
});

test('requires observable oracle checks for success and exposes oracle coverage', () => {
  const rows = [
    record({ result: { status: 'passed', checks: [], completedAt: null } }),
    record({ runId: 'run-inconsistent', result: { status: 'passed', checks: [{ id: 'oracle', passed: false, expected: 'saved', actual: 'pending' }], completedAt: null } }),
  ];
  const summary = summarizeRecords(rows);
  assert.equal(summary.overall.passed, 0);
  assert.equal(summary.overall.oracleCoverage.checkedAttempts, 1);
  assert.equal(summary.overall.oracleCoverage.rate, 0.5);
  assert.ok(summary.recordWarnings.length >= 2);
});

test('missing or incomplete live collection exposes observed contributions, not fabricated zeros', () => {
  const rows = [record(), record({ runId: 'run-no-live', agents: [] }), record({ runId: 'run-partial', collectionCoverage: 'partial' })];
  const summary = summarizeRecords(rows);
  assert.equal(summary.overall.attempts, 3);
  assert.equal(summary.overall.metrics.steps.total, 8);
  assert.equal(summary.overall.metrics.steps.mean, 4);
  assert.equal(summary.overall.metrics.steps.coverage, 'partial');
  assert.equal(summary.overall.metrics.steps.observed, 2);
  assert.equal(summary.overall.metrics.steps.totalSamples, 3);
  assert.equal(summary.overall.collection.none, 1);
  assert.equal(summary.overall.collection.partial, 1);
  assert.equal(summarizeRecords([rows[1]]).overall.metrics.llmDurationMs.total, null);
  const explicitlyUnavailable = summarizeRecords([record({ collectionCoverage: 'none' })]);
  assert.equal(explicitlyUnavailable.overall.metrics.steps.total, null);
  assert.equal(explicitlyUnavailable.overall.metrics.throughput.tokensPerSecond, null);
  const missingSnapshot = summarizeRecords([record({ agents: [agent({ runMetrics: null })] })]);
  assert.equal(missingSnapshot.overall.collection.none, 1);
  assert.equal(missingSnapshot.overall.metrics.steps.total, null);
  const missingParent = summarizeRecords([record({ agents: [agent({ parentAgentId: 'uncollected-agent' })] })]);
  assert.equal(missingParent.overall.collection.partial, 1);
  assert.equal(missingParent.overall.metrics.steps.coverage, 'partial');
});

test('keeps LLM/tool time separate and does not derive browser count from settled steps', () => {
  const value = record({ agents: [agent({ runMetrics: metrics({ llmDurationMs: 700, toolDurationMs: 400 }) }), agent({ agentId: 'agent-child', parentAgentId: 'agent-primary', runMetrics: metrics({ llmDurationMs: 600, toolDurationMs: 500 }) })] });
  const summary = summarizeRecords([value]).overall;
  assert.equal(summary.metrics.llmDurationMs.total, 1300);
  assert.equal(summary.metrics.toolDurationMs.total, 900);
  assert.equal(summary.wallTimeMs.total, 5000);
  assert.equal(summary.metrics.steps.total, 8);
  assert.equal(summary.metrics.toolCalls.browser.total, null);
  const partial = summarizeRecords([record({ toolCalls: { total: 5, browser: 3, failed: null, coverage: 'partial' } })]).overall.metrics.toolCalls;
  assert.equal(partial.browser.coverage, 'partial');
  assert.equal(partial.failed.total, null);
});

test('scripted smoke has its own cohort and no agent/token metrics', () => {
  const summary = summarizeRecords([record(), scripted({ runId: 'run-script' })]);
  const script = summary.byExecution.find((row) => row.execution === 'scripted');
  assert.equal(script.attempts, 1);
  assert.equal(script.metrics.steps.total, null);
  assert.equal(script.metrics.outputTokens.total, null);
  assert.equal(script.metrics.throughput.tokensPerSecond, null);
  assert.equal(summary.byModel.length, 1);
  assert.equal(summary.overall.metrics.steps.totalSamples, 1);
  assert.equal(validateRecord(record({ execution: 'scripted' })).valid, false);
});

test('uses nearest-rank p95 and an averaged even median without inventing empty statistics', () => {
  const rows = Array.from({ length: 20 }, (_, index) => record({ runId: `run-${index}`, wallTimeMs: index + 1 }));
  const stats = summarizeRecords(rows).overall.wallTimeMs;
  assert.equal(stats.median, 10.5);
  assert.equal(stats.p95, 19);
  const empty = buildReport([]);
  assert.equal(empty.json.summary.overall.passRate, null);
  assert.equal(empty.json.summary.overall.wallTimeMs.median, null);
  assert.equal(empty.json.summary.overall.metrics.throughput.tokensPerSecond, null);
  assert.doesNotMatch(empty.html, /NaN|Infinity/);
});

test('matches source-tree changes and requested-model changes while using actual agent configuration', () => {
  const current = record({ wallTimeMs: 3000 });
  const previous = baseline({ wallTimeMs: 5000, requestedModel: 'some-other-request', agents: [agent({ agentId: 'previous-agent' })] });
  const report = buildReport([current], { baselineRecords: [previous] });
  const cohort = report.json.comparison.cohorts[0];
  assert.equal(cohort.matchedPairs, 1);
  assert.equal(cohort.deltas.wallMedianMs.absolute, -2000);
  assert.equal(cohort.deltas.wallMedianMs.relativePercent, -40);
  assert.equal(cohort.deltas.throughputTokensPerSecond.absolute, 0);
  assert.equal(cohort.groups[0].byModel[0].deltas.throughputTokensPerSecond.status, 'comparable');
  assert.ok(cohort.warnings.some((warning) => warning.includes('sample size')));
  assert.match(report.markdown, /source tree|source-tree/i);
  assert.match(report.html, /user-supplied label|user supplied/);
});

test('baseline mismatches identify suite/scenario, seed, execution, actual model and environment boundaries', async (t) => {
  const candidates = [
    ['suite version', baseline({ suite: { id: 'browser-operations', version: '2' } }), 'missing-scenario'],
    ['scenario', baseline({ scenarioId: 'other-workflow' }), 'missing-scenario'],
    ['seed JSON type', baseline({ seed: '7' }), 'seed-mismatch'],
    ['execution', scripted({ runId: 'run-script-baseline', variant: 'baseline' }), 'execution-mismatch'],
    ['actual model', baseline({ agents: [agent({ currentModel: 'model-other' })] }), 'actual-model'],
    ['viewport', baseline({ environment: { ...record().environment, viewport: { width: 1600, height: 900 } } }), 'environment-mismatch'],
    ['browser version', baseline({ environment: { ...record().environment, browser: 'ExampleBrowser/2' } }), 'environment-mismatch'],
    ['additional control', baseline({ environment: { ...record().environment, concurrency: 2 } }), 'environment-mismatch'],
  ];
  for (const [label, value, reason] of candidates) {
    await t.test(label, () => {
      const cohort = buildReport([record()], { baselineRecords: [value] }).json.comparison.cohorts[0];
      assert.equal(cohort.matchedPairs, 0);
      assert.equal(cohort.deltas.wallMedianMs.absolute, null);
      assert.match(cohort.unmatchedCurrent[0].reason, new RegExp(reason));
      assert.equal(cohort.unmatchedBaseline.length, 1);
    });
  }
});

test('unknown task browser or viewport remains incomparable even with matching user labels', () => {
  const environment = { ...record().environment, browser: null, viewport: null, runtimeLabel: 'same-label' };
  const current = record({ environment });
  const previous = baseline({ environment });
  assert.equal(validateRecord(current).valid, true);
  const report = buildReport([current], { baselineRecords: [previous] });
  const cohort = report.json.comparison.cohorts[0];
  assert.equal(cohort.matchedPairs, 0);
  assert.match(cohort.unmatchedCurrent[0].reason, /unknown-environment: environment.browser, environment.viewport/);
  assert.equal(cohort.deltas.wallMedianMs.absolute, null);
  assert.match(report.html, /unknown-environment/);
});

test('unknown, switched and incompletely collected agent configurations cannot form baseline pairs', () => {
  for (const change of [
    { agents: [agent({ currentModel: null })] },
    { agents: [agent({ modelsObserved: ['model-alpha', 'model-beta'] })] },
    { collectionCoverage: 'partial' },
    { agents: [agent({ parentAgentId: 'uncollected-agent' })] },
  ]) {
    const cohort = buildReport([record(change)], { baselineRecords: [baseline(change)] }).json.comparison.cohorts[0];
    assert.equal(cohort.matchedPairs, 0);
    assert.match(cohort.unmatchedCurrent[0].reason, /unresolved-model|incomplete-agent-collection/);
  }
});

test('pairs repetitions once by attempt, retaining failures and showing extra attempts', () => {
  const failedResult = { status: 'failed', checks: [], completedAt: null };
  const current = [
    record({ runId: 'current-three', attempt: 3, wallTimeMs: 1 }),
    record({ runId: 'current-one', attempt: 1, termination: 'timeout', result: failedResult }),
    record({ runId: 'current-two', attempt: 2 }),
  ];
  const previous = [baseline({ runId: 'base-two', attempt: 2 }), baseline({ runId: 'base-one', attempt: 1 })];
  const report = buildReport(current, { baselineRecords: previous });
  const cohort = report.json.comparison.cohorts[0];
  assert.equal(cohort.matchedPairs, 2);
  assert.deepEqual(cohort.pairs.map((pair) => [pair.current.runId, pair.baseline.runId]), [['current-one', 'base-one'], ['current-two', 'base-two']]);
  assert.equal(cohort.current.passRate, 0.5);
  close(report.json.summary.overall.passRate, 2 / 3);
  assert.equal(cohort.deltas.passRate.absolute, -0.5);
  assert.equal(cohort.unmatchedCurrent[0].runId, 'current-three');
  assert.match(cohort.unmatchedCurrent[0].reason, /unpaired-repetition/);
  assert.equal(cohort.baseline.attempts, 2);
});

test('reports scenarios absent on each side and matches only the common subset', () => {
  const report = buildReport([record(), record({ runId: 'current-only', scenarioId: 'current-workflow' })], {
    baselineRecords: [baseline(), baseline({ runId: 'base-only', scenarioId: 'baseline-workflow' })],
  });
  const cohort = report.json.comparison.cohorts[0];
  assert.equal(cohort.matchedPairs, 1);
  assert.deepEqual(cohort.scenarios.missingInBaseline, ['browser-operations@1/current-workflow']);
  assert.deepEqual(cohort.scenarios.missingInCurrent, ['browser-operations@1/baseline-workflow']);
  assert.equal(cohort.unmatchedCurrent.length, 1);
  assert.equal(cohort.unmatchedBaseline.length, 1);
  assert.match(report.markdown, /Missing in baseline/);
});

test('suppresses incomplete metric deltas while retaining comparable results and wall time', () => {
  const current = record({ wallTimeMs: 3000, agents: [agent({ runMetrics: metrics({ coverage: { throughput: 'partial', firstToken: 'none', inputTokens: 'none' } }) })] });
  const cohort = buildReport([current], { baselineRecords: [baseline()] }).json.comparison.cohorts[0];
  assert.equal(cohort.matchedPairs, 1);
  assert.equal(cohort.deltas.wallMedianMs.absolute, -2000);
  assert.equal(cohort.deltas.passRate.absolute, 0);
  for (const field of ['throughputTokensPerSecond', 'firstTokenMeanMs', 'inputTokensTotal']) {
    assert.equal(cohort.deltas[field].absolute, null);
    assert.equal(cohort.deltas[field].status, 'insufficient-coverage');
    assert.equal(cohort.groups[0].byModel[0].deltas[field].absolute, null);
  }
  assert.ok(cohort.warnings.some((warning) => warning.includes('coverage')));
});

test('baseline reports per-model deltas without creating a cross-model tok/s delta', () => {
  const agents = [agent(), agent({ agentId: 'agent-browser', parentAgentId: 'agent-primary', agentType: 'browser-worker', currentModel: 'model-beta', runMetrics: metrics({ throughputOutputTokens: 400 }) })];
  const current = record({ agents });
  const previous = baseline({ agents: agents.map((item) => ({ ...item, runMetrics: metrics({ throughputOutputTokens: 50 }) })) });
  const cohort = buildReport([current], { baselineRecords: [previous] }).json.comparison.cohorts[0];
  assert.equal(cohort.matchedPairs, 1);
  assert.equal(cohort.deltas.throughputTokensPerSecond.absolute, null);
  const modelDeltas = cohort.groups[0].byModel;
  assert.equal(modelDeltas.find((row) => row.model === 'model-alpha').deltas.throughputTokensPerSecond.absolute, 50);
  assert.equal(modelDeltas.find((row) => row.model === 'model-beta').deltas.throughputTokensPerSecond.absolute, 350);
});

test('compares each variant separately, including a zero baseline without infinite relative deltas', () => {
  const report = buildReport([record({ variant: 'candidate-a' }), record({ runId: 'run-b', variant: 'candidate-b' })], {
    baselineRecords: [baseline({ wallTimeMs: 0 })],
  });
  assert.equal(report.json.comparison.cohorts.length, 2);
  for (const cohort of report.json.comparison.cohorts) {
    assert.equal(cohort.matchedPairs, 1);
    assert.equal(cohort.deltas.wallMedianMs.absolute, 5000);
    assert.equal(cohort.deltas.wallMedianMs.relativePercent, null);
  }
  assert.doesNotMatch(report.html, /Infinity|NaN/);
});

test('preserves exact current and baseline raw oracle results, metadata and errors without mutating input', () => {
  const current = record({ error: 'Synthetic capture interruption', annotations: { nested: ['keep', 3, null] } });
  current.result.checks[0].actual = { saved: false, observedRows: ['row-a', 'row-b'] };
  current.result.checks[0].passed = false;
  current.result.status = 'failed';
  const before = structuredClone(current);
  const previous = baseline();
  const report = buildReport([current], { baselineRecords: [previous] });
  assert.deepEqual(current, before);
  assert.deepEqual(report.json.records, [before]);
  assert.deepEqual(report.json.baselineRecords, [previous]);
  assert.match(report.markdown, /observedRows/);
  assert.match(report.html, /Synthetic capture interruption/);
  current.result.checks[0].actual.observedRows.push('later-change');
  assert.deepEqual(report.json.records[0].result.checks[0].actual.observedRows, ['row-a', 'row-b']);
});

test('HTML escapes hostile inputs in fields, raw JSON, oracle values and baseline warnings', () => {
  const attack = '</script><img src=x onerror="globalThis.compromised=true"><script>evil()</script>&\'"';
  const current = record({ scenarioId: attack, variant: attack, error: attack, requestedModel: attack });
  current.result.checks[0] = { id: attack, passed: false, expected: attack, actual: { value: attack } };
  current.result.status = 'failed';
  current.agents[0].coverageNote = attack;
  const report = buildReport([current], { baselineRecords: [baseline({ scenarioId: attack })] });
  assert.equal(report.json.records[0].scenarioId, attack);
  assert.equal((report.html.match(/<script>/g) ?? []).length, 1);
  assert.equal((report.html.match(/<\/script>/g) ?? []).length, 1);
  assert.doesNotMatch(report.html, /<img|<iframe|<link\b|<script\s+src=/i);
  assert.match(report.html, /&lt;img src=x onerror=&quot;/);
  assert.match(report.html, /&amp;&#39;&quot;/);
  assert.match(report.html, /Content-Security-Policy/);
  const script = report.html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script, /compromised|evil|model-alpha/);
});

test('Markdown raw JSON chooses fences that cannot be terminated by an embedded backtick sequence', () => {
  const current = record({ error: '```\n# forged heading\n````' });
  const markdown = buildReport([current]).markdown;
  assert.match(markdown, /`````json\n/);
  assert.match(markdown, /\n`````\n/);
  const tableAttack = record({ scenarioId: '<script>x</script>|[link](https://example.invalid)' });
  assert.doesNotMatch(buildReport([tableAttack]).markdown.split('## Current raw attempts')[0], /<script>/);
});

test('offline filtering changes only visibility and restores all rows when cleared', () => {
  const html = buildReport([record()]).html;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = [{ textContent: 'scenario-one model-alpha', hidden: false }, { textContent: 'scenario-two model-beta', hidden: false }];
  let handler;
  const input = { value: '', addEventListener: (event, callback) => { assert.equal(event, 'input'); handler = callback; } };
  runInNewContext(script, { document: { getElementById: () => input, querySelectorAll: () => elements } });
  input.value = ' MODEL-BETA ';
  handler();
  assert.deepEqual(elements.map((element) => element.hidden), [true, false]);
  input.value = '';
  handler();
  assert.deepEqual(elements.map((element) => element.hidden), [false, false]);
});

test('writeReport writes readable JSON, Markdown and offline HTML only to the selected output directory', { skip: !process.env.BROWSER_BENCHMARK_TEST_TEMP_DIR }, async (t) => {
  const root = process.env.BROWSER_BENCHMARK_TEST_TEMP_DIR;
  await mkdir(root, { recursive: true });
  const outputDir = await mkdtemp(join(root, 'report-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const current = record();
  const previous = baseline();
  const paths = await writeReport([current], { outputDir, baselineRecords: [previous] });
  assert.ok(Object.values(paths).every(isAbsolute));
  assert.deepEqual((await readdir(outputDir)).sort(), ['report.html', 'report.json', 'report.md']);
  const [json, markdown, html] = await Promise.all([readFile(paths.json, 'utf8'), readFile(paths.markdown, 'utf8'), readFile(paths.html, 'utf8')]);
  assert.deepEqual(JSON.parse(json).records, [current]);
  assert.deepEqual(JSON.parse(json).baselineRecords, [previous]);
  assert.match(markdown, /^# Browser operations benchmark/);
  assert.match(html, /^<!doctype html>/);
  await assert.rejects(writeReport([current], { outputDir: '' }), /outputDir/);
});
