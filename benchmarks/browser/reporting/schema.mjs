const COVERAGE = new Set(['none', 'partial', 'complete']);
const TERMINATIONS = new Set(['completed', 'failed', 'timeout', 'cancelled']);
const COUNTS = ['rounds', 'steps', 'firstTokenSamples', 'throughputOutputTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens'];
const DURATIONS = ['llmDurationMs', 'toolDurationMs', 'firstTokenLatencyTotalMs', 'throughputDurationMs'];
const COVERAGE_FIELDS = ['toolTiming', 'firstToken', 'throughput', 'inputTokens', 'outputTokens', 'cacheReadTokens'];

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => nonnegative(value) && Number.isSafeInteger(value);
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Validate the public, JSON-serializable artifact without dropping failed attempts or extra metadata. */
export function validateRecord(record) {
  const errors = [];
  const warnings = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  if (!object(record)) return { valid: false, errors: ['record must be an object'], warnings };
  validateJson(record, 'record', new Set(), errors);
  check(record.schemaVersion === 1, 'schemaVersion must be 1');
  check(object(record.suite) && text(record.suite.id) && text(record.suite.version), 'suite.id and suite.version must be nonempty strings');
  for (const field of ['runId', 'scenarioId', 'variant']) check(text(record[field]), `${field} must be a nonempty string`);
  check(text(record.seed) || (typeof record.seed === 'number' && Number.isFinite(record.seed)), 'seed must be a nonempty string or finite number');
  check(count(record.attempt) && record.attempt >= 1, 'attempt must be a positive safe integer');
  check(['model', 'scripted'].includes(record.execution), 'execution must be model or scripted');
  check(date(record.startedAt), 'startedAt must be a date string');
  check(date(record.endedAt), 'endedAt must be a date string');
  if (date(record.startedAt) && date(record.endedAt)) check(Date.parse(record.endedAt) >= Date.parse(record.startedAt), 'endedAt must not precede startedAt');
  check(nonnegative(record.wallTimeMs), 'wallTimeMs must be a finite nonnegative number');
  check(TERMINATIONS.has(record.termination), 'termination must be completed, failed, timeout, or cancelled');
  if (record.error !== undefined) check(typeof record.error === 'string', 'error must be a string');
  if (record.collectionCoverage !== undefined) check(COVERAGE.has(record.collectionCoverage), 'collectionCoverage must be none, partial, or complete');

  const env = record.environment;
  check(object(env), 'environment must be an object');
  if (object(env)) {
    for (const field of ['revision', 'diffHash', 'node', 'platform']) {
      check(env[field] === null || text(env[field]), `environment.${field} must be a nonempty string or null`);
    }
    check(typeof env.dirty === 'boolean', 'environment.dirty must be a boolean');
    check(env.browser === null || text(env.browser) || object(env.browser), 'environment.browser must be a string, object, or null');
    check(env.viewport === null || (object(env.viewport) && count(env.viewport.width) && env.viewport.width > 0 && count(env.viewport.height) && env.viewport.height > 0), 'environment.viewport must have positive integer width/height, or be null');
  }

  if (record.execution === 'scripted') {
    check(record.agents === undefined, 'scripted records must omit agents');
    check(record.requestedModel === undefined || record.requestedModel === null, 'scripted records must not specify a requestedModel');
  } else if (record.execution === 'model') {
    check(record.requestedModel === null || text(record.requestedModel), 'requestedModel must be a nonempty string or null');
    check(Array.isArray(record.agents), 'model records must include agents (use [] when collection is unavailable)');
    if (Array.isArray(record.agents)) {
      const ids = new Set();
      for (const [index, agent] of record.agents.entries()) {
        const path = `agents[${index}]`;
        check(object(agent), `${path} must be an object`);
        if (!object(agent)) continue;
        check(text(agent.agentId), `${path}.agentId must be a nonempty string`);
        check(!ids.has(agent.agentId), `${path}.agentId must be unique within the record`);
        ids.add(agent.agentId);
        check(agent.parentAgentId === null || text(agent.parentAgentId), `${path}.parentAgentId must be a nonempty string or null`);
        check(text(agent.agentType), `${path}.agentType must be a nonempty string`);
        check(agent.currentModel === null || text(agent.currentModel), `${path}.currentModel must be a nonempty string or null`);
        if (agent.modelsObserved !== undefined) {
          check(Array.isArray(agent.modelsObserved) && agent.modelsObserved.every(text), `${path}.modelsObserved must be an array of nonempty strings`);
          if (Array.isArray(agent.modelsObserved) && agent.currentModel !== null) {
            check(agent.modelsObserved.includes(agent.currentModel), `${path}.modelsObserved must include currentModel`);
          }
        }
        if (agent.coverageNote !== undefined) check(typeof agent.coverageNote === 'string', `${path}.coverageNote must be a string`);
        if (agent.runMetrics === null) warnings.push(`${path}: live metrics unavailable`);
        else validateMetrics(agent.runMetrics, `${path}.runMetrics`, check, warnings);
        if (observedModels(agent).length > 1) warnings.push(`${path}: model changed; cumulative metrics cannot be attributed to one model`);
        if (observedModels(agent).length === 0) warnings.push(`${path}: actual model unknown`);
      }
      const byId = new Map(record.agents.filter(object).map((agent) => [agent.agentId, agent]));
      for (const agent of byId.values()) {
        if (agent.parentAgentId !== null && !byId.has(agent.parentAgentId)) warnings.push(`agent ${agent.agentId}: parent was not collected`);
        const seen = new Set([agent.agentId]);
        let parent = byId.get(agent.parentAgentId);
        while (parent) {
          if (seen.has(parent.agentId)) { errors.push(`agent ${agent.agentId}: parent relationship contains a cycle`); break; }
          seen.add(parent.agentId);
          parent = byId.get(parent.parentAgentId);
        }
      }
      if (record.agents.length === 0) warnings.push('No live agents collected; model metrics are N/A');
    }
  }

  if (record.toolCalls !== undefined) {
    check(object(record.toolCalls), 'toolCalls must be an object');
    if (object(record.toolCalls)) {
      for (const field of ['total', 'browser', 'failed']) check(record.toolCalls[field] === null || count(record.toolCalls[field]), `toolCalls.${field} must be a nonnegative safe integer or null`);
      if (record.toolCalls.coverage !== undefined) check(COVERAGE.has(record.toolCalls.coverage), 'toolCalls.coverage must be none, partial, or complete');
      for (const field of ['browser', 'failed']) {
        if (count(record.toolCalls.total) && count(record.toolCalls[field])) check(record.toolCalls[field] <= record.toolCalls.total, `toolCalls.${field} must not exceed total`);
      }
    }
  }

  if (record.capabilityNotes !== undefined) {
    check(Array.isArray(record.capabilityNotes), 'capabilityNotes must be an array');
    if (Array.isArray(record.capabilityNotes)) {
      for (const [index, note] of record.capabilityNotes.entries()) {
        const valid = object(note) && text(note.capability) && ['observed', 'unavailable'].includes(note.status) && text(note.reason);
        check(valid, `capabilityNotes[${index}] must describe a capability, observed/unavailable status, and reason`);
        if (valid && note.status === 'unavailable') warnings.push(`${note.capability} observation unavailable: ${note.reason}`);
      }
    }
  }

  const result = record.result;
  check(object(result), 'result must be an independent oracle result object');
  if (object(result)) {
    check(['passed', 'failed'].includes(result.status), 'result.status must be passed or failed');
    check(result.completedAt === null || date(result.completedAt), 'result.completedAt must be a date string or null');
    check(Array.isArray(result.checks), 'result.checks must be an array');
    if (Array.isArray(result.checks)) {
      for (const [index, item] of result.checks.entries()) {
        const path = `result.checks[${index}]`;
        check(object(item), `${path} must be an object`);
        if (!object(item)) continue;
        check(text(item.id), `${path}.id must be a nonempty string`);
        check(typeof item.passed === 'boolean', `${path}.passed must be a boolean`);
        check(Object.hasOwn(item, 'expected'), `${path}.expected is required`);
        check(Object.hasOwn(item, 'actual'), `${path}.actual is required`);
      }
      if (result.checks.length === 0) warnings.push('No independent oracle checks available; this attempt is not counted as passed');
      if (result.status === 'passed' && result.checks.some((item) => item?.passed !== true)) warnings.push('Oracle status and checks disagree; this attempt is not counted as passed');
    }
    if (result.status === 'passed' && record.termination !== 'completed') warnings.push('Oracle passed after an unsuccessful termination; this attempt is not counted as passed');
  }
  return { valid: errors.length === 0, errors, warnings };
}

function validateMetrics(metrics, path, check, warnings) {
  check(object(metrics), `${path} must be AgentRunMetrics or null`);
  if (!object(metrics)) return;
  check(metrics.version === 1, `${path}.version must be 1`);
  for (const field of COUNTS) check(count(metrics[field]), `${path}.${field} must be a nonnegative safe integer`);
  for (const field of DURATIONS) check(nonnegative(metrics[field]), `${path}.${field} must be a finite nonnegative number`);
  check(object(metrics.coverage), `${path}.coverage must be an object`);
  if (object(metrics.coverage)) {
    for (const field of COVERAGE_FIELDS) check(COVERAGE.has(metrics.coverage[field]), `${path}.coverage.${field} must be none, partial, or complete`);
    if (metrics.coverage.throughput !== 'none' && metrics.throughputDurationMs === 0) warnings.push(`${path}: zero paired attempt duration; tok/s is N/A`);
    if (metrics.coverage.firstToken !== 'none' && metrics.firstTokenSamples === 0) warnings.push(`${path}: no first-token samples; TTFT is N/A`);
  }
}

function validateJson(value, path, ancestors, errors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') { errors.push(`${path} must contain only JSON values`); return; }
  if (ancestors.has(value)) { errors.push(`${path} contains a circular reference`); return; }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    errors.push(`${path} must be a plain JSON object`);
    return;
  }
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) validateJson(item, `${path}.${key}`, ancestors, errors);
  ancestors.delete(value);
}

export function assertRecords(records, label = 'records') {
  if (!Array.isArray(records)) throw new TypeError(`${label} must be an array`);
  const issues = records.flatMap((record, index) => validateRecord(record).errors.map((error) => `${label}[${index}]: ${error}`));
  if (issues.length) throw new TypeError(`Invalid benchmark artifacts:\n${issues.join('\n')}`);
}

export function observedModels(agent) {
  const values = Array.isArray(agent?.modelsObserved) ? agent.modelsObserved.filter(text) : [];
  if (text(agent?.currentModel)) values.push(agent.currentModel);
  return [...new Set(values)].sort();
}

export function collectionCoverage(record) {
  if (record.execution !== 'model' || record.collectionCoverage === 'none' || record.agents.length === 0
    || record.agents.every((agent) => agent.runMetrics === null)) return 'none';
  const ids = new Set(record.agents.map((agent) => agent.agentId));
  if (record.collectionCoverage === 'partial' || record.agents.some((agent) => agent.runMetrics === null
    || (agent.parentAgentId !== null && !ids.has(agent.parentAgentId)))) return 'partial';
  return 'complete';
}

export function passed(record) {
  return record.termination === 'completed' && record.result.status === 'passed'
    && record.result.checks.length > 0 && record.result.checks.every((item) => item.passed);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function agentRole(record, agent) {
  const byId = new Map((record.agents ?? []).map((item) => [item.agentId, item]));
  const parts = [agent.agentType];
  let parentId = agent.parentAgentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent) { parts.unshift('(uncollected parent)'); break; }
    parts.unshift(parent.agentType);
    parentId = parent.parentAgentId;
  }
  return parts;
}

export function modelConfiguration(record) {
  return (record.agents ?? []).map((agent) => ({ role: agentRole(record, agent), models: observedModels(agent) }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}
