import {
  assertRecords, validateRecord, collectionCoverage, observedModels, passed, agentRole,
  modelConfiguration, stableStringify,
} from './schema.mjs';

const FIELD_COVERAGE = {
  toolDurationMs: 'toolTiming', inputTokens: 'inputTokens', outputTokens: 'outputTokens', cacheReadTokens: 'cacheReadTokens',
};
export const SCALAR_FIELDS = ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'inputTokens', 'outputTokens', 'cacheReadTokens'];
const absent = () => ({ value: null, coverage: 'none' });
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Median averages the two middle values; p95 uses the nearest-rank definition. */
export function distribution(samples) {
  const values = samples.filter((sample) => sample.value !== null).map((sample) => sample.value).sort((a, b) => a - b);
  const n = values.length;
  return {
    total: n ? sum(values) : null,
    mean: n ? sum(values) / n : null,
    median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    p95: n ? values[Math.ceil(n * 0.95) - 1] : null,
    min: n ? values[0] : null,
    max: n ? values[n - 1] : null,
    observed: n,
    totalSamples: samples.length,
    coverage: combinedCoverage(samples.map((sample) => sample.value === null ? 'none' : sample.coverage)),
  };
}

function combinedCoverage(states) {
  if (!states.length || states.every((state) => state === 'none')) return 'none';
  return states.every((state) => state === 'complete') ? 'complete' : 'partial';
}

function entryCoverage(entry, metricCoverage) {
  if (collectionCoverage(entry.record) === 'none' || metricCoverage === 'none') return 'none';
  return collectionCoverage(entry.record) === 'partial' || metricCoverage === 'partial' ? 'partial' : 'complete';
}

function scalarSample(entry, field) {
  const metrics = entry.agent?.runMetrics;
  if (!metrics) return absent();
  const coverage = entryCoverage(entry, FIELD_COVERAGE[field] ? metrics.coverage[FIELD_COVERAGE[field]] : 'complete');
  return coverage === 'none' ? absent() : { value: metrics[field], coverage };
}

function entriesFor(record) {
  if (record.execution !== 'model') return [];
  return record.agents.length ? record.agents.map((agent) => ({ record, agent })) : [{ record, agent: null }];
}

function runScalarSample(record, field) {
  const samples = entriesFor(record).map((entry) => scalarSample(entry, field));
  const known = samples.filter((sample) => sample.value !== null);
  if (!known.length) return absent();
  return { value: sum(known.map((sample) => sample.value)), coverage: combinedCoverage(samples.map((sample) => sample.coverage)) };
}

function throughput(entries) {
  const samples = entries.map((entry) => {
    const metrics = entry.agent?.runMetrics;
    const coverage = metrics ? entryCoverage(entry, metrics.coverage.throughput) : 'none';
    if (coverage === 'none' || metrics.throughputDurationMs <= 0) return { entry, coverage: 'none' };
    return { entry, coverage, tokens: metrics.throughputOutputTokens, duration: metrics.throughputDurationMs };
  });
  const known = samples.filter((sample) => sample.coverage !== 'none');
  const modelSets = known.map((sample) => observedModels(sample.entry.agent));
  const models = [...new Set(modelSets.flat())].sort();
  const attributable = known.length > 0 && modelSets.every((set) => set.length === 1) && models.length === 1;
  const durationMs = known.length ? sum(known.map((sample) => sample.duration)) : null;
  const outputTokens = known.length ? sum(known.map((sample) => sample.tokens)) : null;
  return {
    tokensPerSecond: attributable ? outputTokens / (durationMs / 1000) : null,
    model: attributable ? models[0] : null,
    pairedOutputTokens: outputTokens,
    pairedDurationMs: durationMs,
    coverage: combinedCoverage(samples.map((sample) => sample.coverage)),
    observed: known.length,
    totalSamples: entries.length,
    reason: !known.length ? 'No measured token/duration pairs with a positive duration'
      : !attributable ? 'Multiple or unresolved actual models; no combined tok/s' : null,
  };
}

function firstToken(entries) {
  const samples = entries.map((entry) => {
    const metrics = entry.agent?.runMetrics;
    const coverage = metrics ? entryCoverage(entry, metrics.coverage.firstToken) : 'none';
    if (coverage === 'none' || metrics.firstTokenSamples === 0) return { coverage: 'none' };
    return { coverage, totalMs: metrics.firstTokenLatencyTotalMs, samples: metrics.firstTokenSamples };
  });
  const known = samples.filter((sample) => sample.coverage !== 'none');
  const totalMs = known.length ? sum(known.map((sample) => sample.totalMs)) : null;
  const sampleCount = sum(known.map((sample) => sample.samples));
  return {
    meanMs: sampleCount ? totalMs / sampleCount : null,
    totalMs,
    samples: sampleCount,
    coverage: combinedCoverage(samples.map((sample) => sample.coverage)),
    observed: known.length,
    totalSamples: entries.length,
  };
}

function toolCallMetric(records, field) {
  return distribution(records.map((record) => {
    const value = record.toolCalls?.[field];
    const coverage = record.toolCalls?.coverage ?? 'complete';
    return value === null || value === undefined || coverage === 'none' ? absent() : { value, coverage };
  }));
}

export function aggregateRuns(records) {
  const modelRecords = records.filter((record) => record.execution === 'model');
  const entries = modelRecords.flatMap(entriesFor);
  const successes = records.filter(passed).length;
  const checked = records.filter((record) => record.result.checks.length > 0).length;
  const terminations = Object.fromEntries(['completed', 'failed', 'timeout', 'cancelled'].map((key) => [key, records.filter((record) => record.termination === key).length]));
  const collection = Object.fromEntries(['complete', 'partial', 'none'].map((key) => [key, modelRecords.filter((record) => collectionCoverage(record) === key).length]));
  return {
    attempts: records.length,
    passed: successes,
    failed: records.length - successes,
    passRate: records.length ? successes / records.length : null,
    terminations,
    oracleCoverage: { checkedAttempts: checked, attempts: records.length, rate: records.length ? checked / records.length : null },
    collection: { ...collection, modelAttempts: modelRecords.length },
    wallTimeMs: distribution(records.map((record) => ({ value: record.wallTimeMs, coverage: 'complete' }))),
    metrics: {
      ...Object.fromEntries(SCALAR_FIELDS.map((field) => [field, distribution(modelRecords.map((record) => runScalarSample(record, field)))])),
      throughput: throughput(entries),
      firstToken: firstToken(entries),
      toolCalls: Object.fromEntries(['total', 'browser', 'failed'].map((field) => [field, toolCallMetric(records, field)])),
    },
  };
}

export function aggregateAgents(entries) {
  const records = [...new Set(entries.map((entry) => entry.record))];
  return {
    agentSamples: entries.length,
    participatingAttempts: records.length,
    passedAttempts: records.filter(passed).length,
    passRate: records.length ? records.filter(passed).length / records.length : null,
    metrics: {
      ...Object.fromEntries(SCALAR_FIELDS.map((field) => [field, distribution(entries.map((entry) => scalarSample(entry, field)))])),
      throughput: throughput(entries),
      firstToken: firstToken(entries),
    },
  };
}

export function modelRows(records) {
  const groups = new Map();
  for (const record of records) {
    for (const agent of record.agents ?? []) {
      const models = observedModels(agent);
      const dimensions = {
        suite: record.suite,
        scenarioId: record.scenarioId,
        variant: record.variant,
        execution: record.execution,
        agentType: agent.agentType,
        role: agentRole(record, agent),
        attribution: models.length === 1 ? 'single' : models.length ? 'multiple' : 'unknown',
        model: models.length === 1 ? models[0] : null,
        modelsObserved: models,
      };
      const key = stableStringify(dimensions);
      if (!groups.has(key)) groups.set(key, { dimensions, entries: [] });
      groups.get(key).entries.push({ record, agent });
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({ ...group.dimensions, ...aggregateAgents(group.entries) }));
}

function runGroups(records, dimensions) {
  const groups = new Map();
  for (const record of records) {
    const fields = dimensions(record);
    const key = stableStringify(fields);
    if (!groups.has(key)) groups.set(key, { fields, records: [] });
    groups.get(key).records.push(record);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({ ...group.fields, ...aggregateRuns(group.records) }));
}

/** Every attempt remains in its cohort denominator, including timeouts and absent telemetry. */
export function summarizeRecords(records) {
  assertRecords(records);
  const overall = aggregateRuns(records);
  const warnings = [];
  if (records.length < 5) warnings.push(`Only ${records.length} attempts; descriptive statistics have a small sample. No statistical significance is claimed.`);
  if (overall.terminations.timeout || overall.terminations.failed || overall.terminations.cancelled) warnings.push('Failed, timed-out, and cancelled attempts remain in every relevant denominator and wall-time distribution.');
  if (overall.oracleCoverage.checkedAttempts < records.length) warnings.push('Some attempts have no independent oracle checks; they count as unsuccessful.');
  if (overall.collection.partial || overall.collection.none) warnings.push('Live agent collection is incomplete. Partial values describe observed contributions, not estimated totals.');
  if (overall.metrics.throughput.reason && overall.collection.modelAttempts) warnings.push(overall.metrics.throughput.reason);
  const recordWarnings = records.flatMap((record, index) => validateRecord(record).warnings.map((message) => ({ index, runId: record.runId, scenarioId: record.scenarioId, message })));
  return {
    recordCount: records.length,
    overall,
    byExecution: runGroups(records, (record) => ({ execution: record.execution })),
    byScenario: runGroups(records, (record) => ({ suite: record.suite, scenarioId: record.scenarioId, execution: record.execution })),
    byVariant: runGroups(records, (record) => ({ suite: record.suite, variant: record.variant, execution: record.execution })),
    groups: runGroups(records, (record) => ({
      suite: record.suite, scenarioId: record.scenarioId, variant: record.variant, execution: record.execution,
      modelConfiguration: modelConfiguration(record),
    })),
    byModel: modelRows(records),
    warnings,
    recordWarnings,
  };
}
