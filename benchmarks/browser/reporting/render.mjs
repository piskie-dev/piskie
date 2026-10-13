import { passed, modelConfiguration, stableStringify } from './schema.mjs';

export const DEFINITIONS = [
  'Pass rate = completed attempts with a passed independent oracle status and at least one check, all passing, divided by all attempts in that cohort. Failed, timed-out and cancelled attempts remain in the denominator.',
  'Scripted runs are page/oracle smoke tests. Their model metrics are N/A and their execution cohort is separate from model runs.',
  'Wall time includes every attempt. Median averages the middle two samples; p95 is the nearest-rank percentile. Small samples are descriptive, not evidence of statistical significance.',
  'Steps are all settled tool calls, including failed and non-browser tools. Browser tool counts are shown only when separately collected.',
  'tok/s = sum of paired provider output tokens / sum of the corresponding successful final-attempt durations in seconds, including TTFT. It is not decode speed and is not the arithmetic mean of per-run rates.',
  'TTFT = total first-token latency / measured first-token samples. Missing metrics are N/A; partial metrics contain only observed contributions. Tokens are never estimated or filled with zero.',
  'Models come from each live agent, including parent and children independently. Requested model is informational. A changed or unknown model is not assigned a single-model tok/s; different models never share a combined rate.',
  'LLM time and tool time are reported separately. Tool time merges overlapping intervals within each agent; sums across agents can overlap and are not wall-clock time. Runtime metrics cover settled work, so interrupted active work may not appear in those counters.',
  'Agent-role pass rates describe the outcomes of attempts that included that role, not independent agent success or causal model performance. Coverage counts are run samples in run tables and agent samples in model tables.',
  'Source revision, dirty status and diff hash describe the source tree, not proof of the build loaded by an already-running application. runtimeLabel is a user-supplied label, not a measured build identity. Browser and viewport must describe the actual task browser; unknown values stay null.',
  'Baseline differences use only one-to-one matched attempts with the same suite/version, scenario, seed, execution, actual model configuration and measured environment. Variant and source/build labels may differ. Unmatched records remain visible; metric deltas require complete coverage on both matched subsets.',
];

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const display = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const number = (value) => value === null || value === undefined ? 'N/A' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const percent = (value) => value === null ? 'N/A' : `${number(value * 100)}%`;
const metric = (value, field = 'total', scale = 1, unit = '') => {
  if (value[field] === null || value[field] === undefined) return `N/A${value.reason ? ` (${value.reason})` : ''}`;
  const coverage = value.coverage === 'partial' ? ` [partial; ${value.observed}/${value.totalSamples} samples]` : '';
  return `${number(value[field] / scale)}${unit}${coverage}`;
};
const diff = (value, scale = 1, unit = '') => {
  if (value.absolute === null) return `N/A (${value.status}${value.reason ? `: ${value.reason}` : ''})`;
  const sign = value.absolute > 0 ? '+' : '';
  return `${sign}${number(value.absolute / scale)}${unit}${value.relativePercent === null ? '' : ` (${value.relativePercent > 0 ? '+' : ''}${number(value.relativePercent)}%)`}`;
};
const configLabel = (configuration) => configuration.length ? configuration.map((entry) => `${entry.role.join('/')}: ${entry.models.length ? entry.models.join(', ') : 'unknown'}${entry.models.length > 1 ? ' (changed)' : ''}`).join('; ') : 'N/A';
const modelLabel = (row) => row.model ?? (row.modelsObserved.length ? `${row.modelsObserved.join(', ')} (changed; unattributed)` : 'unknown');
const suiteScenario = (row) => `${row.suite.id}@${row.suite.version} / ${row.scenarioId}`;

function executionTable(summary) {
  return {
    title: 'Execution cohorts',
    headers: ['Execution', 'Attempts', 'Passed', 'Pass rate', 'Oracle checks', 'Wall median', 'Wall p95', 'Steps mean', 'LLM total', 'Tool total', 'Browser calls'],
    rows: summary.byExecution.map((row) => [row.execution, row.attempts, row.passed, percent(row.passRate), `${row.oracleCoverage.checkedAttempts}/${row.attempts}`, metric(row.wallTimeMs, 'median', 1000, ' s'), metric(row.wallTimeMs, 'p95', 1000, ' s'), metric(row.metrics.steps, 'mean'), metric(row.metrics.llmDurationMs, 'total', 1000, ' s'), metric(row.metrics.toolDurationMs, 'total', 1000, ' s'), metric(row.metrics.toolCalls.browser)]),
  };
}

function scenarioTable(summary) {
  return {
    title: 'Scenario, variant and actual model configuration',
    headers: ['Scenario', 'Variant', 'Execution', 'Actual agent models', 'Attempts', 'Pass rate', 'Wall median', 'Wall p95', 'Steps mean', 'Rounds mean', 'Browser calls'],
    rows: summary.groups.map((row) => [suiteScenario(row), row.variant, row.execution, configLabel(row.modelConfiguration), row.attempts, percent(row.passRate), metric(row.wallTimeMs, 'median', 1000, ' s'), metric(row.wallTimeMs, 'p95', 1000, ' s'), metric(row.metrics.steps, 'mean'), metric(row.metrics.rounds, 'mean'), metric(row.metrics.toolCalls.browser)]),
  };
}

function modelsTable(summary) {
  return {
    title: 'Metrics by actual agent model and role',
    headers: ['Scenario', 'Variant', 'Agent role', 'Actual model', 'Passing attempts / participating', 'Agent samples', 'tok/s (full attempt)', 'TTFT mean', 'Input tokens', 'Output tokens', 'Cache read tokens', 'Steps mean / agent', 'LLM total', 'Tool total'],
    rows: summary.byModel.map((row) => [suiteScenario(row), row.variant, row.role.join('/'), modelLabel(row), `${row.passedAttempts}/${row.participatingAttempts}`, row.agentSamples, metric(row.metrics.throughput, 'tokensPerSecond'), metric(row.metrics.firstToken, 'meanMs', 1, ' ms'), metric(row.metrics.inputTokens), metric(row.metrics.outputTokens), metric(row.metrics.cacheReadTokens), metric(row.metrics.steps, 'mean'), metric(row.metrics.llmDurationMs, 'total', 1000, ' s'), metric(row.metrics.toolDurationMs, 'total', 1000, ' s')]),
  };
}

function provenanceTable(records) {
  const groups = new Map();
  for (const record of records) {
    const key = stableStringify({ variant: record.variant, execution: record.execution, environment: record.environment });
    groups.set(key, record);
  }
  return {
    title: 'Recorded environment and source-tree provenance',
    headers: ['Variant', 'Execution', 'Source revision', 'Dirty', 'Source diff hash', 'Runtime label (user supplied)', 'Node', 'Platform', 'Task browser', 'Task viewport'],
    rows: [...groups.values()].map((record) => {
      const env = record.environment;
      return [record.variant, record.execution, env.revision ?? 'unknown', String(env.dirty), env.diffHash ?? 'N/A', env.runtimeLabel ?? 'unknown', env.node ?? 'unknown', env.platform ?? 'unknown', env.browser === null ? 'unknown' : display(env.browser), env.viewport === null ? 'unknown' : `${env.viewport.width} × ${env.viewport.height}`];
    }),
  };
}

function coverageTable(summary) {
  return {
    title: 'Collection and termination coverage',
    headers: ['Execution', 'Completed', 'Failed', 'Timeout', 'Cancelled', 'Live collection complete', 'Live collection partial', 'Live collection unavailable'],
    rows: summary.byExecution.map((row) => [row.execution, row.terminations.completed, row.terminations.failed, row.terminations.timeout, row.terminations.cancelled, row.execution === 'model' ? row.collection.complete : 'N/A', row.execution === 'model' ? row.collection.partial : 'N/A', row.execution === 'model' ? row.collection.none : 'N/A']),
  };
}

function baselineTable(cohort) {
  return {
    title: 'Matched scenario/seed differences (current − baseline)',
    headers: ['Scenario', 'Seed', 'Execution', 'Actual models', 'Pairs', 'Pass rate Δ (pp)', 'Wall median Δ', 'Wall p95 Δ', 'Steps mean Δ', 'Browser calls Δ'],
    rows: cohort.groups.map((row) => [suiteScenario(row), display(row.seed), row.execution, configLabel(row.modelConfiguration), row.matchedPairs, diff(row.deltas.passRate, 0.01, ' pp'), diff(row.deltas.wallMedianMs, 1000, ' s'), diff(row.deltas.wallP95Ms, 1000, ' s'), diff(row.deltas.stepsMean), diff(row.deltas.browserToolCallsTotal)]),
  };
}

function baselineModelsTable(cohort) {
  return {
    title: 'Matched model/role metric differences (current − baseline)',
    headers: ['Scenario', 'Seed', 'Role', 'Model', 'tok/s Δ', 'TTFT Δ', 'Input tokens Δ', 'Output tokens Δ', 'Cache read Δ', 'LLM total Δ', 'Tool total Δ'],
    rows: cohort.groups.flatMap((group) => group.byModel.map((row) => [suiteScenario(group), display(group.seed), row.role.join('/'), row.model ?? row.modelsObserved.join(', '), diff(row.deltas.throughputTokensPerSecond), diff(row.deltas.firstTokenMeanMs, 1, ' ms'), diff(row.deltas.inputTokensTotal), diff(row.deltas.outputTokensTotal), diff(row.deltas.cacheReadTokensTotal), diff(row.deltas.llmDurationTotalMs, 1000, ' s'), diff(row.deltas.toolDurationTotalMs, 1000, ' s')])),
  };
}

function unmatchedTable(cohort) {
  return {
    title: 'Unmatched attempts',
    headers: ['Side', 'Run', 'Scenario', 'Seed', 'Attempt', 'Reason'],
    rows: [['current', cohort.unmatchedCurrent], ['baseline', cohort.unmatchedBaseline]].flatMap(([side, rows]) => rows.map((row) => [side, row.runId, row.scenarioId, display(row.seed), row.attempt, row.reason])),
  };
}

const escapeMarkdown = (value) => escapeHtml(value).replace(/[\\`*_{}[\]()#|!]/g, '\\$&').replace(/\r?\n/g, '<br>');
function markdownTable(table) {
  const row = (cells) => `| ${cells.map(escapeMarkdown).join(' | ')} |`;
  return `### ${table.title}\n\n${row(table.headers)}\n${row(table.headers.map(() => '---'))}\n${table.rows.length ? table.rows.map(row).join('\n') : row(table.headers.map((_, index) => index === 0 ? 'No observations' : '—'))}\n`;
}
function fence(value) {
  const text = JSON.stringify(value, null, 2);
  const length = Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const delimiter = '`'.repeat(length);
  return `${delimiter}json\n${text}\n${delimiter}`;
}
const bulletLines = (values) => values.map((value) => `- ${escapeMarkdown(value)}`).join('\n');

function baselineDescription(cohort) {
  return `${cohort.matchedPairs} matched pairs; current ${cohort.matchedPairs}/${cohort.currentAttempts} (${percent(cohort.matchedCurrentRate)}), baseline ${cohort.matchedPairs}/${cohort.baselineAttempts} (${percent(cohort.matchedBaselineRate)}). Matched-subset pass rate: current ${percent(cohort.current.passRate)}, baseline ${percent(cohort.baseline.passRate)}. Wall median: current ${metric(cohort.current.wallTimeMs, 'median', 1000, ' s')}, baseline ${metric(cohort.baseline.wallTimeMs, 'median', 1000, ' s')}.`;
}

export function renderMarkdown(report) {
  const { summary, comparison, records, baselineRecords } = report;
  const sections = [
    '# Browser operations benchmark',
    `${records.length} recorded attempts. Model and scripted execution cohorts are reported separately.`,
    '## Metric definitions', bulletLines(report.definitions),
    '## Observations and limitations', summary.warnings.length ? bulletLines(summary.warnings) : 'No aggregate collection warnings.',
    ...[executionTable(summary), scenarioTable(summary), modelsTable(summary), coverageTable(summary), provenanceTable(records)].map(markdownTable),
  ];
  if (summary.recordWarnings.length) sections.push(markdownTable({ title: 'Record warnings', headers: ['Run', 'Scenario', 'Warning'], rows: summary.recordWarnings.map((item) => [item.runId, item.scenarioId, item.message]) }));
  sections.push('## Baseline comparison');
  if (!comparison.baselineProvided) sections.push('No baseline records supplied.');
  for (const cohort of comparison.cohorts) {
    sections.push(`### ${escapeMarkdown(cohort.variant)} vs ${escapeMarkdown(cohort.baselineVariant)}`, escapeMarkdown(baselineDescription(cohort)), bulletLines(cohort.warnings));
    if (cohort.scenarios.missingInBaseline.length) sections.push(`Missing in baseline: ${cohort.scenarios.missingInBaseline.map(escapeMarkdown).join(', ')}.`);
    if (cohort.scenarios.missingInCurrent.length) sections.push(`Missing in current: ${cohort.scenarios.missingInCurrent.map(escapeMarkdown).join(', ')}.`);
    sections.push(...[baselineTable(cohort), baselineModelsTable(cohort), unmatchedTable(cohort)].map(markdownTable));
  }
  for (const [label, runs] of [['Current', records], ['Baseline', baselineRecords]]) {
    sections.push(`## ${label} raw attempts and oracle checks`);
    for (const record of runs) {
      sections.push(`### ${escapeMarkdown(record.runId)} / ${escapeMarkdown(record.scenarioId)} / ${escapeMarkdown(record.variant)} / attempt ${record.attempt}`);
      sections.push(`${passed(record) ? 'PASSED' : 'FAILED'} · termination: ${escapeMarkdown(record.termination)} · oracle: ${escapeMarkdown(record.result.status)} · wall: ${number(record.wallTimeMs / 1000)} s · seed: ${escapeMarkdown(display(record.seed))} · requested model: ${escapeMarkdown(record.requestedModel ?? 'N/A')} · actual: ${escapeMarkdown(configLabel(modelConfiguration(record)))}`);
      sections.push(markdownTable({ title: 'Independent oracle checks', headers: ['Check', 'Passed', 'Expected', 'Actual'], rows: record.result.checks.map((item) => [item.id, String(item.passed), display(item.expected), display(item.actual)]) }));
      sections.push(fence(record));
    }
  }
  return `${sections.join('\n\n')}\n`;
}

function htmlTable(table) {
  const cells = (values, tag) => values.map((value) => `<${tag}>${escapeHtml(value)}</${tag}>`).join('');
  return `<section><h3>${escapeHtml(table.title)}</h3><div class="table-scroll"><table><thead><tr>${cells(table.headers, 'th')}</tr></thead><tbody>${table.rows.length ? table.rows.map((row) => `<tr data-filter-row>${cells(row, 'td')}</tr>`).join('') : `<tr><td colspan="${table.headers.length}">No observations</td></tr>`}</tbody></table></div></section>`;
}
const htmlList = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
const badge = (isPassed, label) => `<span class="badge ${isPassed ? 'pass' : 'fail'}">${escapeHtml(label)}</span>`;

function htmlRun(record) {
  const result = passed(record);
  const summary = `${record.runId} · ${record.scenarioId} · ${record.variant} · ${record.execution} · attempt ${record.attempt} · seed ${display(record.seed)}`;
  return `<details class="run" data-filter-card><summary>${badge(result, result ? 'PASSED' : 'FAILED')} ${escapeHtml(summary)}</summary>
<p>Termination: ${escapeHtml(record.termination)} · Oracle status: ${escapeHtml(record.result.status)} · Wall: ${number(record.wallTimeMs / 1000)} s · Oracle completed: ${escapeHtml(record.result.completedAt ?? 'unavailable')}</p>
<p>Requested model: ${escapeHtml(record.requestedModel ?? 'N/A')} · Actual models: ${escapeHtml(configLabel(modelConfiguration(record)))}</p>
${record.error ? `<pre class="error">${escapeHtml(record.error)}</pre>` : ''}
${(record.agents ?? []).filter((agent) => agent.coverageNote).map((agent) => `<p>${escapeHtml(agent.agentId)}: ${escapeHtml(agent.coverageNote)}</p>`).join('')}
<h4>Independent oracle checks</h4><div class="table-scroll"><table><thead><tr><th>Check</th><th>Result</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${record.result.checks.length ? record.result.checks.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${badge(item.passed, item.passed ? 'PASS' : 'FAIL')}</td><td><pre>${escapeHtml(display(item.expected))}</pre></td><td><pre>${escapeHtml(display(item.actual))}</pre></td></tr>`).join('') : '<tr><td colspan="4">No independent checks available; attempt counts as unsuccessful.</td></tr>'}</tbody></table></div>
<details><summary>Complete raw attempt (including environment and agent metrics)</summary><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre></details></details>`;
}

export function renderHtml(report) {
  const { summary, records, baselineRecords, comparison } = report;
  const tables = [executionTable(summary), scenarioTable(summary), modelsTable(summary), coverageTable(summary), provenanceTable(records)];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Browser operations benchmark</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;font-size:14px}*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#162337}main{max-width:1600px;margin:auto;padding:28px}h1{font-size:28px;margin:0 0 10px}h2{margin-top:28px}h3{font-size:16px;margin:18px 0 10px}h4{margin:14px 0 8px}p,li{line-height:1.55}li{margin:5px 0}.subtle{color:#4c5e73}.table-scroll{overflow:auto;border:1px solid #d8e0eb;border-radius:8px;background:#fff}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;vertical-align:top;padding:9px 11px;border-bottom:1px solid #e7ecf3;min-width:78px;max-width:400px;overflow-wrap:anywhere}th{background:#edf2f8;position:sticky;top:0;font-size:12px}tr:last-child td{border:0}tbody tr:nth-child(even){background:#f8fafd}.badge{display:inline-block;border-radius:12px;font-size:11px;font-weight:700;padding:3px 8px;vertical-align:middle}.pass{background:#d3f1e2;color:#155537}.fail{background:#ffe0df;color:#8c2327}.warning{border-left:4px solid #b57a13;background:#fff3d7;padding:10px 16px;margin:14px 0;border-radius:4px}details{border:1px solid #d8e0eb;border-radius:8px;padding:12px;background:#fff;margin:10px 0}summary{cursor:pointer;font-weight:600;line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:8px 0;line-height:1.5}.error{color:#8c2327}input{font:inherit;width:min(100%,560px);padding:10px 12px;border:1px solid #91a1b6;border-radius:7px;background:#fff;color:inherit}label{display:block;margin:20px 0 8px;font-weight:600}[hidden]{display:none!important}footer{margin-top:24px;font-size:12px}@media(prefers-color-scheme:dark){body{background:#101824;color:#e1e8f3}.subtle{color:#b1bfd2}.table-scroll,details,input{background:#172232;border-color:#344256}th{background:#223147}td,th{border-color:#344256}tbody tr:nth-child(even){background:#1b293d}.warning{background:#352b18}.error{color:#ffb6b3}}@media print{input,label,.filter-hint{display:none}main{padding:0}.table-scroll{overflow:visible}th{position:static}details{break-inside:avoid}body{background:#fff;color:#000}}
</style></head><body><main>
<h1>Browser operations benchmark</h1><p class="subtle">${records.length} recorded attempts. Model and scripted execution cohorts are reported separately. Offline report; no external resources.</p>
<details><summary>Metric definitions and interpretation</summary>${htmlList(report.definitions)}</details>
${summary.warnings.length ? `<div class="warning">${htmlList(summary.warnings)}</div>` : ''}
<label for="report-filter">Filter scenario, variant, model, status or run</label><input id="report-filter" type="search" placeholder="Type to filter tables and raw attempts" autocomplete="off"><p class="subtle filter-hint">Filtering changes visibility only; totals always describe the full supplied dataset. Clear the filter to show every attempt.</p>
${tables.map(htmlTable).join('\n')}
${summary.recordWarnings.length ? htmlTable({ title: 'Record warnings', headers: ['Run', 'Scenario', 'Warning'], rows: summary.recordWarnings.map((item) => [item.runId, item.scenarioId, item.message]) }) : ''}
<h2>Baseline comparison</h2>${comparison.baselineProvided ? '' : '<p>No baseline records supplied.</p>'}
${comparison.cohorts.map((cohort) => `<section><h3>${escapeHtml(cohort.variant)} vs ${escapeHtml(cohort.baselineVariant)}</h3><p>${escapeHtml(baselineDescription(cohort))}</p><div class="warning">${htmlList(cohort.warnings)}</div>${cohort.scenarios.missingInBaseline.length ? `<p>Missing in baseline: ${escapeHtml(cohort.scenarios.missingInBaseline.join(', '))}</p>` : ''}${cohort.scenarios.missingInCurrent.length ? `<p>Missing in current: ${escapeHtml(cohort.scenarios.missingInCurrent.join(', '))}</p>` : ''}${[baselineTable(cohort), baselineModelsTable(cohort), unmatchedTable(cohort)].map(htmlTable).join('')}</section>`).join('')}
<h2>Current attempts: actual oracle checks and raw records</h2>${records.map(htmlRun).join('\n')}
${baselineRecords.length ? `<h2>Baseline attempts: actual oracle checks and raw records</h2>${baselineRecords.map(htmlRun).join('\n')}` : ''}
<footer class="subtle">N/A means unavailable or not comparable. Partial means observed contributions only. LLM/tool sums are not elapsed wall time. Source-tree metadata and user build labels do not attest to the loaded application build.</footer>
</main><script>
const filter = document.getElementById('report-filter');
filter.addEventListener('input', () => {
  const query = filter.value.trim().toLocaleLowerCase();
  for (const element of document.querySelectorAll('[data-filter-row], [data-filter-card]')) {
    element.hidden = query !== '' && !element.textContent.toLocaleLowerCase().includes(query);
  }
});
</script></body></html>\n`;
}
