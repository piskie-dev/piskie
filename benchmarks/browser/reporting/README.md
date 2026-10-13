# Browser benchmark reporting

Native Node 24 ESM; no added dependencies. Import `benchmarks/browser/reporting/index.mjs` from the benchmark CLI. The module reads no application state, does not control a browser, and does not restart the application.

```js
import {
  validateRecord, summarizeRecords, buildReport, writeReport,
} from './reporting/index.mjs';

const validation = validateRecord(record); // { valid, errors: string[], warnings: string[] }
const summary = summarizeRecords(records);
const { json, markdown, html } = buildReport(records, { baselineRecords });
const paths = await writeReport(records, { outputDir, baselineRecords });
// { json: '/absolute/output/report.json',
//   markdown: '/absolute/output/report.md', html: '/absolute/output/report.html' }
```

`buildReport` is deterministic and returns a JSON object plus two strings. `summarizeRecords`, `buildReport`, and `writeReport` throw `TypeError` with indexed field errors for malformed artifacts. They never silently discard failed attempts. `validateRecord` does not throw for an invalid JSON artifact. Extra JSON metadata is preserved. Keep test output and smoke reports in the task's temporary directory.

## Artifact contract, version 1

Each array entry is one scenario attempt, including setup failures, timeouts, cancellations, and failed oracle checks. Use fresh run identities and preserve the source artifacts for every repetition.

```ts
type Coverage = 'none' | 'partial' | 'complete';
type Record = {
  schemaVersion: 1;
  suite: { id: string; version: string }; // current suite: browser-operations / 1
  runId: string;
  scenarioId: string;
  seed: string | number;
  attempt: number; // positive integer
  variant: string;
  execution: 'model' | 'scripted';
  startedAt: string; // date string, normally ISO 8601
  endedAt: string;
  wallTimeMs: number; // measured nonnegative elapsed wall time
  termination: 'completed' | 'failed' | 'timeout' | 'cancelled';
  environment: {
    revision: string | null;
    dirty: boolean;
    diffHash: string | null;
    node: string | null;
    platform: string | null;
    browser: string | { [key: string]: Json } | null;
    viewport: { width: number; height: number } | null;
    runtimeLabel?: string; // user supplied, not evidence of the loaded build
    [key: string]: Json | undefined;
  };
  requestedModel?: string | null; // required for model, null/omitted for scripted
  agents?: Array<{ // required for model, omitted for scripted
    agentId: string;
    parentAgentId: string | null;
    agentType: string;
    currentModel: string | null;
    modelsObserved?: string[]; // complete observed set; includes currentModel
    runMetrics: AgentRunMetrics | null;
    coverageNote?: string;
    [key: string]: Json | undefined;
  }>;
  collectionCoverage?: Coverage;
  toolCalls?: {
    total: number | null;
    browser: number | null;
    failed: number | null;
    coverage?: Coverage;
  };
  result: {
    status: 'passed' | 'failed';
    checks: Array<{ id: string; passed: boolean; expected: Json; actual: Json }>;
    completedAt: string | null;
    [key: string]: Json | undefined;
  };
  error?: string;
  [key: string]: Json | undefined;
};
```

`Json` means a JSON value; omit absent optional properties rather than assigning `undefined`. `AgentRunMetrics` is the version-1 contract in `shared/types/agent-control.ts`: `rounds`, `steps`, `llmDurationMs`, `toolDurationMs`, `firstTokenLatencyTotalMs`, `firstTokenSamples`, `throughputDurationMs`, `throughputOutputTokens`, `inputTokens`, `outputTokens`, `cacheReadTokens`, and `coverage` for `toolTiming`, `firstToken`, `throughput`, `inputTokens`, `outputTokens`, and `cacheReadTokens`. Counts are nonnegative integers; durations are finite nonnegative numbers.

The collector must take metrics from live control states. Historical state returns zero metrics and cannot establish measured zeros. If collection fails, retain the attempt with `agents: []`, or retain the known agent/model and use `runMetrics: null`. `collectionCoverage` describes capture of the entire live agent tree: use `partial` when a child or part of the run was missed, and `none` when no live metrics were collected. If omitted, the report infers collection completeness from the supplied agents and metric availability; this is not verification that polling actually covered the run.

Collect parent and child `currentModel` independently. Preserve the set of models observed over the entire attempt when any model changes. A cumulative metric with multiple observed models remains in its own unattributed row; it is never assigned to the final model. `requestedModel` is displayed but does not control metric attribution or baseline matching.

`result` is the server-side independent oracle response, including actual check values. The reporting module validates its structure, not its origin: the collector is responsible for using the server oracle rather than a model's self-reported success. If an oracle cannot be obtained, use a failed result with empty checks, `completedAt: null`, and an explanatory error. Such an attempt remains unsuccessful even if a supplied status says passed without supporting checks. Scripted smoke runs omit agents and model metrics entirely and have their own execution cohort.

`environment.browser` and `viewport` must describe the task browser, not an Electron renderer or application window. Use `null` for unavailable values. Record relevant controlled conditions such as machine/architecture, provider configuration, reasoning settings, concurrency, browser mode, and network profile under `environment` when collected. Per-attempt observations and timestamps belong outside `environment` because all non-build environment fields participate in matching.

Source `revision`, `dirty`, and `diffHash` identify the working tree, including uncommitted optimization changes. They do not prove which build an already-running application has loaded. `runtimeLabel` is only the user's explicit build label. Reports preserve and explain both kinds of metadata. Do not relabel source-tree metadata as measured runtime build identity.

## Summary and fixed metric definitions

`summary` includes `overall`, `byExecution`, `byScenario`, `byVariant`, `groups` (suite/scenario/variant/execution/actual agent configuration), `byModel` (suite/scenario/variant/agent role/actual model), `warnings`, and indexed `recordWarnings`. Parent roles are represented by a path of agent types, independent of ephemeral IDs. `overall` counts every artifact; use `byExecution` for model benchmark versus scripted smoke conclusions.

Run aggregates expose `attempts`, `passed`, `failed`, `passRate`, `terminations`, `oracleCoverage`, `collection`, `wallTimeMs`, and `metrics`:

- Pass rate counts only completed attempts whose independent status is passed, with at least one check and all checks passing. Its denominator includes every attempt in that cohort. `failed` means not passed, including timeout/cancelled; `terminations` retains the exact reason.
- Wall time uses all attempts, including failures. Median averages the two central observations. p95 is nearest rank, `sorted[ceil(n × .95) - 1]`. Small-sample warnings make clear that this is descriptive.
- Scalar distributions expose `total`, `mean`, `median`, `p95`, `min`, `max`, `observed`, `totalSamples`, and `coverage`. Unavailable values are `null`, never invented zero. With partial coverage, values summarize only observed contributions, and means use observed samples. Run scalar metrics first sum captured agent contributions within each run; model rows summarize individual agents.
- Steps count all settled tools, including failed and non-browser tools. They are not browser actions or LLM rounds. Browser tool counts come only from `toolCalls.browser`; they are not inferred from steps. Tool-call classification can separately declare partial coverage.
- Throughput uses **only paired** `throughputOutputTokens` and positive `throughputDurationMs`: `sum(tokens) / (sum(durationMs) / 1000)`. The denominator is the full successful final attempt, including TTFT. Neither total output tokens, total LLM time, nor wall time substitutes for the paired fields. Zero known output with positive duration is a real zero rate. Missing or zero duration gives N/A. Partial pair coverage is labeled and is ineligible for baseline throughput deltas.
- `metrics.throughput` exposes `tokensPerSecond`, `model`, `pairedOutputTokens`, `pairedDurationMs`, `coverage`, `observed`, `totalSamples`, and `reason`. A combined rate exists only when every contributing pair has the same known single actual model. Multiple-model and changed-model rates are N/A; stable actual models have separate rows.
- `metrics.firstToken.meanMs = sum(firstTokenLatencyTotalMs) / sum(firstTokenSamples)`. Sample weighting is preserved. Raw samples and totals are included. No samples means N/A.
- Provider input, output, and cache-read tokens use each field's coverage independently. Complete provider zero is displayed as zero. A zero behind `none` is not evidence of a measured zero.
- LLM and tool time are separate. Tool time already merges concurrent intervals within one agent. Summing agents can double-count overlapping wall intervals; that sum is labeled as agent time, not elapsed time. Runtime counters cover settled work; interrupted in-flight requests may not appear.
- Model-row success rates are **participating attempt outcomes**, not causal model performance or separate child-agent oracle results.

The JSON report retains deep copies of **every current and baseline raw record**, including checks, errors, environment extensions, observed models, and metric coverage. Markdown and HTML include full per-attempt records and independent checks. The HTML is self-contained, escapes untrusted strings (including raw JSON), and uses a fixed inline filter script without interpolating record data into JavaScript. Filtering only changes visibility; displayed aggregates remain full-dataset aggregates.

## Baseline matching and interpretation

`comparison.cohorts` compares each current variant against each baseline variant. Each cohort exposes totals, matched rates, `pairs`, exact-condition `groups`, `unmatchedCurrent`, `unmatchedBaseline`, scenario coverage, matched summaries, `deltas`, and warnings. Each exact-condition group also has separate `byModel` deltas.

An exact condition includes suite ID/version, scenario, seed including JSON type, execution, actual agent role/model configuration, and every recorded environment field except `revision`, `dirty`, `diffHash`, and `runtimeLabel`. Those excluded fields identify the candidates being compared. Actual agent configuration includes multiplicity, parent role paths, and observed models; agent IDs and requested models do not participate. Different actual parent/browser models remain separately attributed even when both appear in the same matched scenario.

Unknown browser/viewport or other unknown recorded environmental values (`null`, empty, `unknown`, `N/A`, `unavailable`) are explicitly incomparable. An incomplete agent capture, missing parent, unknown model, or changed model is also incomparable. A matching user label does not turn an unknown measured environment into a match. Environment matching only establishes equality of recorded controls; it is not proof that every external condition was controlled.

Within an exact condition, repetitions are sorted by `attempt`, `startedAt`, and `runId`, then paired one-to-one. Extra repetitions stay unmatched; no observation is reused within a variant comparison. Match selection never depends on pass/fail status or measured performance. Baseline observations may be used in separate variant comparisons, which are independent descriptive tables. Scenarios absent on either side and every unmatched attempt are listed. Matched-subset pass rates do not replace full-cohort pass rates.

Deltas are **current minus baseline** and expose `current`, `baseline`, `absolute`, `relativePercent`, `status`, and `reason`. An increase in speed and an increase in elapsed time have different meanings; reports present values without declaring an improvement. Relative delta is N/A for a zero baseline. Metrics require complete coverage on both paired subsets; result and wall-time differences can still be available when provider token/TTFT coverage is insufficient. Cross-model combined tok/s stays N/A even when the scenario itself is comparable. Fewer than five matched pairs, missing scenarios, unmatched attempts, and partial coverage are explicit limitations. No statistical-significance claim is generated.

Run the module tests with:

```sh
node --test benchmarks/browser/tests/report*.test.mjs
```

Tests use synthetic generic records, not actual benchmark measurements. Disk-output tests run only when `BROWSER_BENCHMARK_TEST_TEMP_DIR` is explicitly set to the task's temporary directory; no default workspace output is created.
