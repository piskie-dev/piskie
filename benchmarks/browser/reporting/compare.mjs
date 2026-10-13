import { collectionCoverage, modelConfiguration, stableStringify } from './schema.mjs';
import { aggregateRuns, modelRows } from './metrics.mjs';

// These identify the candidate being evaluated, rather than controlled conditions.
const BUILD_FIELDS = new Set(['revision', 'dirty', 'diffHash', 'runtimeLabel']);
export const COMPARISON_POLICY = {
  match: ['suite.id', 'suite.version', 'scenarioId', 'seed (including its JSON type)', 'execution', 'observed agent role/model configuration', 'all recorded environment fields except build labels'],
  buildFields: [...BUILD_FIELDS],
  pairing: 'Within each variant pair and exact condition, pair repetitions one-to-one by attempt, startedAt, then runId. Keep all unmatched attempts visible.',
  coverage: 'Metric deltas require complete coverage on both paired subsets. Unknown key environments or unresolved model configurations are incomparable.',
  interpretation: 'Descriptive, matched-subset differences only. No automatic significance or improvement claim. A runtimeLabel is user supplied, not verification of a loaded build.',
};

function environmentConditions(record) {
  return Object.fromEntries(Object.entries(record.environment).filter(([key]) => !BUILD_FIELDS.has(key)));
}

function unknown(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !value.trim() || /^(unknown|n\/a|unavailable)$/i.test(value.trim());
  if (Array.isArray(value)) return value.some(unknown);
  if (typeof value === 'object') return Object.keys(value).length === 0 || Object.values(value).some(unknown);
  return false;
}

function matchCondition(record) {
  const environment = environmentConditions(record);
  const missing = Object.entries(environment).filter(([, value]) => unknown(value)).map(([key]) => `environment.${key}`);
  if (missing.length) return { key: null, reason: `unknown-environment: ${missing.join(', ')}` };
  const models = modelConfiguration(record);
  if (record.execution === 'model') {
    if (collectionCoverage(record) !== 'complete' || !models.length) return { key: null, reason: 'incomplete-agent-collection: actual model configuration cannot be verified' };
    if (models.some((item) => item.models.length !== 1)) return { key: null, reason: 'unresolved-model: unknown or changing actual agent model' };
    const ids = new Set(record.agents.map((agent) => agent.agentId));
    if (record.agents.some((agent) => agent.parentAgentId !== null && !ids.has(agent.parentAgentId))) return { key: null, reason: 'incomplete-agent-collection: an agent parent was not collected' };
  }
  const dimensions = {
    suite: record.suite, scenarioId: record.scenarioId, seed: record.seed,
    execution: record.execution, modelConfiguration: models, environment,
  };
  return { key: stableStringify(dimensions), dimensions };
}

const reference = (record) => ({ runId: record.runId, scenarioId: record.scenarioId, seed: record.seed, attempt: record.attempt, variant: record.variant, execution: record.execution });
const order = (a, b) => a.attempt - b.attempt || Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId);

function unmatchedReason(record, others) {
  const own = matchCondition(record);
  if (!own.key) return own.reason;
  let candidates = others.filter((item) => item.suite.id === record.suite.id && item.suite.version === record.suite.version && item.scenarioId === record.scenarioId);
  if (!candidates.length) return 'missing-scenario-or-suite-version';
  candidates = candidates.filter((item) => stableStringify(item.seed) === stableStringify(record.seed));
  if (!candidates.length) return 'seed-mismatch';
  candidates = candidates.filter((item) => item.execution === record.execution);
  if (!candidates.length) return 'execution-mismatch';
  candidates = candidates.filter((item) => stableStringify(modelConfiguration(item)) === stableStringify(modelConfiguration(record)));
  if (!candidates.length) return 'actual-model-configuration-mismatch';
  candidates = candidates.filter((item) => stableStringify(environmentConditions(item)) === stableStringify(environmentConditions(record)));
  if (!candidates.length) return 'environment-mismatch';
  if (candidates.some((item) => matchCondition(item).key === own.key)) return 'unpaired-repetition: no unused matching attempt';
  return `counterpart-incomparable: ${matchCondition(candidates[0]).reason}`;
}

function delta(current, baseline, currentCoverage = 'complete', baselineCoverage = 'complete', reason = null) {
  const complete = currentCoverage === 'complete' && baselineCoverage === 'complete';
  const comparable = complete && current !== null && baseline !== null;
  return {
    current, baseline,
    absolute: comparable ? current - baseline : null,
    relativePercent: comparable && baseline !== 0 ? ((current - baseline) / Math.abs(baseline)) * 100 : null,
    status: comparable ? 'comparable' : !complete ? 'insufficient-coverage' : 'unavailable',
    reason: comparable ? null : reason ?? (!complete ? 'Complete coverage is required on both paired subsets' : 'No comparable observations'),
  };
}

function metricDeltas(current, baseline) {
  const scalar = (field, statistic) => delta(current[field][statistic], baseline[field][statistic], current[field].coverage, baseline[field].coverage);
  return {
    stepsMean: scalar('steps', 'mean'),
    roundsMean: scalar('rounds', 'mean'),
    llmDurationTotalMs: scalar('llmDurationMs', 'total'),
    toolDurationTotalMs: scalar('toolDurationMs', 'total'),
    inputTokensTotal: scalar('inputTokens', 'total'),
    outputTokensTotal: scalar('outputTokens', 'total'),
    cacheReadTokensTotal: scalar('cacheReadTokens', 'total'),
    throughputTokensPerSecond: delta(current.throughput.tokensPerSecond, baseline.throughput.tokensPerSecond, current.throughput.coverage, baseline.throughput.coverage, current.throughput.reason ?? baseline.throughput.reason),
    firstTokenMeanMs: delta(current.firstToken.meanMs, baseline.firstToken.meanMs, current.firstToken.coverage, baseline.firstToken.coverage),
  };
}

function runDeltas(current, baseline) {
  return {
    passRate: delta(current.passRate, baseline.passRate),
    wallMedianMs: delta(current.wallTimeMs.median, baseline.wallTimeMs.median),
    wallP95Ms: delta(current.wallTimeMs.p95, baseline.wallTimeMs.p95),
    ...metricDeltas(current.metrics, baseline.metrics),
    browserToolCallsTotal: delta(current.metrics.toolCalls.browser.total, baseline.metrics.toolCalls.browser.total, current.metrics.toolCalls.browser.coverage, baseline.metrics.toolCalls.browser.coverage),
  };
}

function modelComparisons(currentRecords, baselineRecords) {
  const current = modelRows(currentRecords);
  const baseline = modelRows(baselineRecords);
  const key = (row) => stableStringify({ suite: row.suite, scenarioId: row.scenarioId, role: row.role, modelsObserved: row.modelsObserved });
  const baselineMap = new Map(baseline.map((row) => [key(row), row]));
  return current.flatMap((row) => {
    const other = baselineMap.get(key(row));
    return other ? [{ role: row.role, model: row.model, modelsObserved: row.modelsObserved, current: row, baseline: other, deltas: metricDeltas(row.metrics, other.metrics) }] : [];
  });
}

function compareCohort(currentRecords, baselineRecords, variant, baselineVariant) {
  const buckets = new Map();
  for (const record of baselineRecords.slice().sort(order)) {
    const condition = matchCondition(record);
    if (!condition.key) continue;
    if (!buckets.has(condition.key)) buckets.set(condition.key, []);
    buckets.get(condition.key).push(record);
  }
  const pairs = [];
  const usedBaseline = new Set();
  const unmatchedCurrent = [];
  for (const current of currentRecords.slice().sort(order)) {
    const condition = matchCondition(current);
    const bucket = condition.key && buckets.get(condition.key);
    const baseline = bucket?.shift();
    if (!baseline) { unmatchedCurrent.push({ ...reference(current), reason: unmatchedReason(current, baselineRecords) }); continue; }
    usedBaseline.add(baseline);
    pairs.push({ current, baseline, condition });
  }
  const unmatchedBaseline = baselineRecords.filter((record) => !usedBaseline.has(record)).map((record) => ({ ...reference(record), reason: unmatchedReason(record, currentRecords) }));
  const current = aggregateRuns(pairs.map((pair) => pair.current));
  const baseline = aggregateRuns(pairs.map((pair) => pair.baseline));
  const grouped = new Map();
  for (const pair of pairs) {
    if (!grouped.has(pair.condition.key)) grouped.set(pair.condition.key, { condition: pair.condition.dimensions, pairs: [] });
    grouped.get(pair.condition.key).pairs.push(pair);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
    const currentRuns = group.pairs.map((pair) => pair.current);
    const baselineRuns = group.pairs.map((pair) => pair.baseline);
    const currentSummary = aggregateRuns(currentRuns);
    const baselineSummary = aggregateRuns(baselineRuns);
    return {
      ...group.condition, matchedPairs: group.pairs.length,
      current: currentSummary, baseline: baselineSummary,
      deltas: runDeltas(currentSummary, baselineSummary),
      byModel: modelComparisons(currentRuns, baselineRuns),
    };
  });
  const scenarioKey = (record) => `${record.suite.id}@${record.suite.version}/${record.scenarioId}`;
  const currentScenarios = [...new Set(currentRecords.map(scenarioKey))].sort();
  const baselineScenarios = [...new Set(baselineRecords.map(scenarioKey))].sort();
  const warnings = [];
  if (!pairs.length) warnings.push('No comparable attempts. All deltas are N/A.');
  if (pairs.length < 5) warnings.push(`Only ${pairs.length} matched pairs; sample size is insufficient for a reliable improvement claim.`);
  if (groups.some((group) => group.matchedPairs < 5) && pairs.length >= 5) warnings.push('Some scenario/seed/model groups have fewer than five matched pairs; inspect each group before drawing conclusions.');
  if (unmatchedCurrent.length || unmatchedBaseline.length) warnings.push('Comparison covers only the matched subset; unmatched attempts remain in the full report. Subset pass rates are not full-suite pass rates.');
  if (groups.some((group) => Object.values(group.deltas).some((item) => item.status === 'insufficient-coverage'))) warnings.push('Some metric deltas are unavailable because coverage is incomplete.');
  warnings.push('Differences are current minus baseline. No statistical significance is asserted.');
  return {
    variant, baselineVariant,
    currentAttempts: currentRecords.length, baselineAttempts: baselineRecords.length,
    matchedPairs: pairs.length,
    matchedCurrentRate: currentRecords.length ? pairs.length / currentRecords.length : null,
    matchedBaselineRate: baselineRecords.length ? pairs.length / baselineRecords.length : null,
    current, baseline, deltas: runDeltas(current, baseline), groups,
    pairs: pairs.map((pair) => ({ current: reference(pair.current), baseline: reference(pair.baseline) })),
    unmatchedCurrent, unmatchedBaseline,
    scenarios: {
      current: currentScenarios, baseline: baselineScenarios,
      matched: [...new Set(pairs.map((pair) => scenarioKey(pair.current)))].sort(),
      missingInBaseline: currentScenarios.filter((id) => !baselineScenarios.includes(id)),
      missingInCurrent: baselineScenarios.filter((id) => !currentScenarios.includes(id)),
    },
    warnings,
  };
}

export function compareRecords(records, baselineRecords) {
  const variants = [...new Set(records.map((record) => record.variant))].sort();
  const baselineVariants = [...new Set(baselineRecords.map((record) => record.variant))].sort();
  return {
    policy: COMPARISON_POLICY,
    baselineProvided: baselineRecords.length > 0,
    currentAttempts: records.length,
    baselineAttempts: baselineRecords.length,
    cohorts: variants.flatMap((variant) => baselineVariants.map((baselineVariant) => compareCohort(
      records.filter((record) => record.variant === variant),
      baselineRecords.filter((record) => record.variant === baselineVariant), variant, baselineVariant,
    ))),
  };
}
