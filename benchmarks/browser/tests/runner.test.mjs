import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assertLocalUrl, buildBenchmarkPrompt, createAgentSession, createModelBenchmarkRunner,
  createStateCollector, isQuiescent, validateBenchmarkOptions } from '../runner/piskie.mjs';
import { validateRecord } from '../reporting/schema.mjs';

const environment = { revision: 'sample-revision', dirty: false, diffHash: 'sample-diff', node: process.version,
  platform: process.platform, browser: null, viewport: null, runtimeLabel: 'unknown' };

function metrics(steps = 4) {
  return { version: 1, rounds: 2, steps, llmDurationMs: 100, toolDurationMs: 40,
    firstTokenLatencyTotalMs: 20, firstTokenSamples: 2, throughputDurationMs: 90, throughputOutputTokens: 24,
    inputTokens: 80, outputTokens: 24, cacheReadTokens: 30,
    coverage: { toolTiming: 'complete', firstToken: 'partial', throughput: 'complete', inputTokens: 'complete', outputTokens: 'complete', cacheReadTokens: 'partial' } };
}

function root(overrides = {}) {
  return { agentId: 'sample-main', agentSpec: 'system-chat', phase: 'waiting', currentModel: 'sample::coordinator',
    pendingEvents: [], children: [], runMetrics: metrics(), aiRequestState: { phase: 'finished', outcome: 'success' }, ...overrides };
}

function child(overrides = {}) {
  return { id: 'sample-child', type: 'browser-worker', phase: 'waiting', currentModel: 'sample::browser',
    pendingEvents: [], runMetrics: metrics(6), taskState: { inputAt: 100, notification: { type: 'completed', at: 200 } }, ...overrides };
}

function event(state, source = 'observer') { return { agentId: 'sample-main', state, source }; }
const finalConversation = { entries: [{ kind: 'turn', finalAssistant: true }], complete: true };
const oracle = (status = 'passed') => ({ status, checks: [{ id: 'saved', passed: status === 'passed', expected: true, actual: status === 'passed' }], completedAt: new Date().toISOString() });

function fixture() {
  const runs = new Map();
  let sequence = 0;
  return {
    baseUrl: 'http://127.0.0.1:4000',
    createRun({ scenarioId, seed }) {
      const runId = `sample-run-${++sequence}`;
      const run = { runId, scenarioId, seed, url: `http://127.0.0.1:4000/workspace?runId=${runId}`,
        task: 'Save the delivery details and check the receipt.', createdAt: new Date().toISOString() };
      runs.set(runId, run);
      return run;
    },
    evaluateRun() { return oracle(); },
    getRun(id) { return runs.get(id); },
  };
}

async function directory(t) {
  const base = process.env.BROWSER_BENCHMARK_TEST_TEMP_DIR ?? tmpdir();
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, 'sample-browser-benchmark-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function options(outputDir, extra = {}) {
  return { fixture: fixture(), scenarioIds: ['sample-scenario'], model: 'sample::coordinator', variant: 'sample-variant',
    timeoutMs: 1000, outputDir, environment, ...extra };
}

function fakeConnection({ onStart, onRead, onStop } = {}) {
  const listeners = new Set();
  const states = { 'unrelated-main': root({ agentId: 'unrelated-main' }) };
  const starts = [];
  const stops = [];
  const order = [];
  let disconnects = 0;
  const emit = (state, id = state?.agentId) => {
    if (state) states[id] = state; else delete states[id];
    for (const listener of listeners) listener({ agentId: id, state });
  };
  const api = {
    observeState(listener) { order.push('observe'); listeners.add(listener); return () => listeners.delete(listener); },
    async listStates() { order.push('list'); await onRead?.({ states, emit }); return { ...states }; },
    async start(request) {
      order.push('start'); starts.push(request);
      const agentId = `sample-main-${starts.length}`;
      if (onStart) return onStart({ agentId, request, emit, states, index: starts.length });
      const state = root({ agentId, children: [child()] }); emit(state); return state;
    },
    async conversation(_id, request) {
      const entries = [{ t: 'msg', role: 'assistant', content: 'The receipt is saved.' }];
      return { from: request.from, entries: entries.slice(request.from), total: entries.length };
    },
    async stop(id) { stops.push(id); await onStop?.(id); emit(null, id); },
  };
  return { api, emit, states, starts, stops, order, listeners,
    get disconnects() { return disconnects; },
    async connect() {
      return { async prepare() { const session = createAgentSession(api); await session.prepare(); return session; },
        async disconnect() { disconnects++; } };
    },
  };
}

const runner = (connection, overrides = {}) => createModelBenchmarkRunner({ connect: () => connection.connect(), pollIntervalMs: 1, settleMs: 0, ioTimeoutMs: 100, ...overrides });

async function assertArtifacts(outputDir, records) {
  const files = await readdir(join(outputDir, 'records'));
  assert.equal(files.length, records.length);
  for (const record of records) {
    assert.deepEqual(validateRecord(record).errors, []);
    assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'records', `${record.runId}.json`), 'utf8')), record);
  }
}

test('validates every option before connecting or creating an attempt', async (t) => {
  const outputDir = await directory(t);
  let connected = false;
  const run = createModelBenchmarkRunner({ connect: async () => { connected = true; throw new Error('unexpected connection'); } });
  for (const change of [
    { model: 'model-without-provider' }, { model: '::model' }, { model: 'provider::' }, { model: '' }, { model: 3 },
    { model: ' sample::model' }, { repeats: 0 }, { repeats: 1.5 }, { seed: -1 }, { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 }, { scenarioIds: [] }, { scenarioIds: ['sample', 'sample'] },
    { variant: '' }, { workspace: 'relative-workspace' }, { outputDir: '' }, { onRecord: 'callback' }, { signal: {} },
    { cdpUrl: 'http://example.invalid:9223' }, { environment: { ...environment, viewport: { width: 0, height: 100 } } },
    { environment: { ...environment, browser: [] } },
    { environment: { ...environment, consoleEvidencePolicy: 'unknown-policy' } },
  ]) await assert.rejects(run(options(outputDir, change)), TypeError);
  assert.equal(connected, false);
  assert.equal(validateBenchmarkOptions(options(outputDir, { model: null })).model, null);
});

test('restricts discovery, renderer, and fixture URLs to loopback endpoints', () => {
  for (const url of ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223']) assertLocalUrl(url);
  for (const url of ['https://example.invalid', 'file:///sample/app.html', 'http://user:pass@localhost:9223', 'http://localhost.example.invalid']) {
    assert.throws(() => assertLocalUrl(url), TypeError);
  }
  assertLocalUrl('ws://127.0.0.1:9223/devtools/browser/sample', 'CDP', ['ws:', 'wss:']);
});

test('task prompt contains the resolved business URL and upload instruction', () => {
  const run = fixture().createRun({ scenarioId: 'sample', seed: 1 });
  const prompt = buildBenchmarkPrompt(run, 'http://127.0.0.1:4000');
  assert.ok(prompt.includes(run.url));
  assert.ok(prompt.includes(run.task));
  assert.match(prompt, /real browser UI/);
  assert.match(prompt, /upload control/);
  assert.throws(() => buildBenchmarkPrompt({ ...run, task: 'Upload {{attachmentPath}}' }, 'http://127.0.0.1:4000'), /unresolved/);
  assert.throws(() => buildBenchmarkPrompt({ ...run, url: 'http://localhost:4001' }, 'http://127.0.0.1:4000'), /fixture server/);
});

test('console exception is explicit, limited to diagnostics, and retained in environment metadata', async (t) => {
  const site = fixture();
  const task = site.createRun({ scenarioId: 'diagnostics', seed: 1 });
  const fallback = buildBenchmarkPrompt(task, site.baseUrl, { allowMissingConsole: true });
  assert.match(fallback, /does not expose console events/);
  assert.match(fallback, /network observations to verify the original failed request’s error code and trace ID/);
  assert.match(fallback, /Do not invent console evidence/);
  assert.match(fallback, /All other task requirements still apply/);
  assert.ok(!buildBenchmarkPrompt(task, site.baseUrl).includes('does not expose console events'));
  assert.ok(!buildBenchmarkPrompt({ ...task, scenarioId: 'sample-other' }, site.baseUrl, { allowMissingConsole: true }).includes('does not expose console events'));
  const outputDir = await directory(t);
  const connection = fakeConnection();
  const [record] = await runner(connection)(options(outputDir, { scenarioIds: ['diagnostics'], environment: { ...environment, consoleEvidencePolicy: 'optional' } }));
  assert.equal(record.environment.consoleEvidencePolicy, 'optional');
  assert.match(connection.starts[0].input, /does not expose console events/);
  assert.equal(validateBenchmarkOptions(options(outputDir)).environment.consoleEvidencePolicy, 'required');
  await assertArtifacts(outputDir, [record]);
});

test('missing API and unavailable output directory fail before model work', async (t) => {
  assert.throws(() => createAgentSession({ start() {} }), /observeState.*listStates.*conversation.*stop/);
  const outputDir = await directory(t);
  const blocker = join(outputDir, 'sample-file');
  await writeFile(blocker, 'sample');
  let connected = false;
  const run = createModelBenchmarkRunner({ connect: async () => { connected = true; throw new Error('Piskie Agent API unavailable: stop'); } });
  await assert.rejects(run(options(blocker)));
  assert.equal(connected, false);
  const input = options(outputDir);
  input.fixture.createRun = () => assert.fail('preflight must finish before fixture attempts');
  await assert.rejects(run(input), /Agent API unavailable/);
});

test('keeps short-lived worker metrics, actual models, and model changes before removal', () => {
  const collector = createStateCollector('sample-main');
  collector.ingest(event(root({ children: [child({ phase: 'executing', currentModel: 'sample::first', taskState: { inputAt: 100 } })] })));
  collector.ingest(event(root({ children: [child({ currentModel: 'sample::second' })] })));
  collector.ingest(event(root()));
  collector.conversation(finalConversation);
  assert.equal(collector.outcome(), 'completed');
  collector.captureTermination();
  const result = collector.result();
  assert.equal(result.collectionCoverage, 'complete');
  assert.equal(result.agents[0].currentModel, 'sample::coordinator');
  assert.equal(result.agents[1].currentModel, 'sample::second');
  assert.deepEqual(result.agents[1].modelsObserved, ['sample::first', 'sample::second']);
  assert.deepEqual(result.agents[1].runMetrics, metrics(6));
  assert.match(result.agents[1].coverageNote, /cannot be split by model/);
  result.agents[1].runMetrics.steps = 900;
  assert.equal(collector.result().agents[1].runMetrics.steps, 6);
});

test('a terminal notification during tool execution does not prove final metrics', () => {
  const collector = createStateCollector('sample-main');
  collector.ingest(event(root({ children: [child({ phase: 'executing', runMetrics: metrics(5) })] })));
  collector.conversation(finalConversation);
  assert.equal(collector.outcome(), null);
  collector.ingest(event(root()));
  collector.captureTermination();
  assert.equal(collector.result().collectionCoverage, 'partial');
  assert.deepEqual(collector.result().agents[1].runMetrics, metrics(5));
  assert.match(collector.result().agents[1].coverageNote, /quiescent/);
});

test('waiting, pending work, and human-action notifications are not completion', () => {
  const collector = createStateCollector('sample-main');
  collector.ingest(event(root()));
  assert.equal(collector.outcome(), null);
  for (const pending of [{ pendingQuestion: {} }, { pendingToolCall: {} }, { pendingEvents: [{}] },
    { activeStartedAt: 10 }, { activeLlmStartedAt: 10 }, { activeToolPhaseStartedAt: 10 }, { aiRequestState: { phase: 'backoff' } }]) {
    assert.equal(isQuiescent(root(pending)), false);
  }
  collector.conversation(finalConversation);
  collector.ingest(event(root({ children: [child({ pendingQuestion: {}, taskState: { inputAt: 100, notification: { type: 'need_user_action', at: 200 } } })] })));
  assert.equal(collector.outcome(), null);
  collector.ingest(event(root({ children: [child({ taskState: { inputAt: 100, notification: { type: 'stalled', at: 200 } } })] })));
  assert.equal(collector.outcome(), 'completed');
  collector.captureTermination();
  assert.equal(collector.result().collectionCoverage, 'partial');
});

test('new assignments reset terminal coverage', () => {
  const collector = createStateCollector('sample-main');
  collector.ingest(event(root({ children: [child()] })));
  collector.ingest(event(root({ children: [child({ taskState: { inputAt: 300 } })] })));
  collector.conversation(finalConversation);
  collector.captureTermination();
  assert.equal(collector.result().collectionCoverage, 'partial');
});

test('missing live child snapshots keep unknown metrics, and snapshots alone are partial', () => {
  const collector = createStateCollector('sample-main');
  collector.ingest(event(root(), 'snapshot'));
  collector.conversation({ entries: [{ kind: 'child', agentId: 'sample-missed', agentType: 'browser-worker' }, ...finalConversation.entries], complete: true });
  collector.captureTermination();
  const result = collector.result();
  assert.equal(result.collectionCoverage, 'partial');
  assert.equal(result.agents[1].runMetrics, null);
  assert.equal(result.agents[1].currentModel, null);
  assert.deepEqual(result.agents[1].modelsObserved, []);
  assert.match(result.agents[0].coverageNote, /No live observer event/);
});

test('renderer subscribes before start, retains transient children, and projects only measurement fields', async () => {
  const connection = fakeConnection({ onStart({ agentId, emit }) {
    emit(root({ agentId, phase: 'executing', children: [child({ phase: 'executing', runMetrics: metrics(3) })] }));
    emit(root({ agentId, children: [child({ runMetrics: metrics(8) })] }));
    const state = root({ agentId, runConfig: { privateValue: 'sample-private-config' } });
    emit(state); return state;
  } });
  const session = createAgentSession(connection.api);
  await session.prepare();
  const state = await session.start({ input: 'Sample task', modeId: 'normal' });
  const collector = createStateCollector(state.agentId);
  collector.ingest({ agentId: state.agentId, state, source: 'start' });
  const batch = await session.read();
  for (const item of batch.events) collector.ingest(item);
  collector.conversation(batch.conversation);
  collector.captureTermination();
  assert.deepEqual(connection.order.slice(0, 3), ['observe', 'list', 'start']);
  assert.equal(collector.result().collectionCoverage, 'complete');
  assert.equal(collector.result().agents[1].runMetrics.steps, 8);
  assert.ok(!JSON.stringify(batch).includes('sample-private-config'));
  assert.ok(!JSON.stringify(batch).includes('unrelated-main'));
  await session.stop(); session.close();
  assert.deepEqual(connection.stops, [state.agentId]);
  assert.equal(connection.listeners.size, 0);
});

test('a snapshot RPC cannot overwrite a newer observer update', async () => {
  let listener;
  const initial = root();
  let reads = 0;
  const api = {
    observeState(callback) { listener = callback; return () => {}; },
    async listStates() {
      if (++reads === 1) return {};
      listener(event(root({ runMetrics: metrics(9) })));
      return { 'sample-main': root({ runMetrics: metrics(1) }) };
    },
    async start() { return initial; },
    async conversation() { return { from: 0, entries: [], total: 0 }; },
    async stop() {},
  };
  const session = createAgentSession(api);
  await session.prepare(); await session.start({});
  const collector = createStateCollector(initial.agentId);
  for (const item of (await session.read()).events) collector.ingest(item);
  assert.equal(collector.result().agents[0].runMetrics.steps, 9);
  session.close();
});

test('runner persists failed oracle results separately from task completion and repeats independent runs', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection();
  const site = fixture();
  site.evaluateRun = () => oracle('failed');
  const records = await runner(connection)(options(outputDir, { fixture: site, repeats: 2 }));
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.termination === 'completed' && record.result.status === 'failed'));
  assert.deepEqual(records.map((record) => record.attempt), [1, 2]);
  assert.deepEqual(records.map((record) => record.seed), [1, 1]);
  assert.ok(records.every((record) => record.collectionCoverage === 'complete'));
  assert.deepEqual(connection.starts[0].launchOptions, { initialModel: 'sample::coordinator' });
  assert.equal(connection.starts[0].modeId, 'normal');
  assert.equal(records[0].agents[1].currentModel, 'sample::browser');
  assert.equal(records[0].environment.browser, null);
  assert.equal(records[0].environment.viewport, null);
  assert.equal(connection.disconnects, 1);
  assert.equal(connection.listeners.size, 0);
  await assertArtifacts(outputDir, records);
});

test('deadline retains live measurements, stops only the owned run, and continues with the next scenario', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection({ onStart({ agentId, index, emit }) {
    const state = root({ agentId, ...(index === 1 ? { phase: 'executing', activeStartedAt: 1 } : {}), children: [child()] });
    emit(state); return state;
  } });
  const records = await runner(connection)(options(outputDir, { scenarioIds: ['sample-slow', 'sample-next'], timeoutMs: 35 }));
  assert.deepEqual(records.map((record) => record.termination), ['timeout', 'completed']);
  assert.equal(records[0].collectionCoverage, 'partial');
  assert.equal(records[0].agents[0].runMetrics.steps, 4);
  assert.ok(records[0].wallTimeMs >= 25);
  assert.deepEqual(connection.stops, ['sample-main-1', 'sample-main-2']);
  assert.ok(connection.states['unrelated-main']);
  assert.equal(connection.listeners.size, 0);
  await assertArtifacts(outputDir, records);
});

test('a launch resolving after timeout is stopped in the renderer without touching other agents', async (t) => {
  const outputDir = await directory(t);
  let resolveStart;
  const connection = fakeConnection({ onStart({ agentId }) {
    return new Promise((resolve) => { resolveStart = () => resolve(root({ agentId })); });
  } });
  const records = await runner(connection)(options(outputDir, { timeoutMs: 20 }));
  assert.equal(records[0].termination, 'timeout');
  assert.equal(records[0].collectionCoverage, 'none');
  assert.deepEqual(records[0].agents, []);
  assert.match(records[0].error, /renderer will stop this launch/);
  assert.deepEqual(connection.stops, []);
  resolveStart();
  await delay(1);
  assert.deepEqual(connection.stops, ['sample-main-1']);
  assert.ok(connection.states['unrelated-main']);
  assert.equal(connection.listeners.size, 0);
  await assertArtifacts(outputDir, records);
});

test('API failures and notification callback errors preserve artifacts and later attempts', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection({ onStart({ agentId, index, emit }) {
    if (index === 1) throw new Error('Sample provider unavailable');
    const state = root({ agentId }); emit(state); return state;
  } });
  const records = await runner(connection)(options(outputDir, { repeats: 2, onRecord: () => { throw new Error('Sample display failed'); } }));
  assert.deepEqual(records.map((record) => record.termination), ['failed', 'completed']);
  assert.match(records[0].error, /provider unavailable/);
  assert.match(records[1].error, /display failed/);
  assert.deepEqual(connection.stops, ['sample-main-2']);
  assert.equal(connection.listeners.size, 0);
  await assertArtifacts(outputDir, records);
});

test('normal terminal metrics stay complete across cleanup stopping and released states', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection({ onStop(agentId) {
    connection.emit(root({ agentId, phase: 'stopping', runMetrics: metrics(90),
      children: [child({ phase: 'stopping', runMetrics: metrics(99) })] }));
  } });
  const [record] = await runner(connection)(options(outputDir));
  assert.equal(record.termination, 'completed');
  assert.equal(record.collectionCoverage, 'complete');
  assert.deepEqual(record.agents[0].runMetrics, metrics(4));
  assert.deepEqual(record.agents[1].runMetrics, metrics(6));
  assert.equal(record.agents[1].coverageNote, undefined);
  assert.deepEqual(connection.stops, ['sample-main-1']);
  await assertArtifacts(outputDir, [record]);
});

test('timeout uses the last pre-deadline samples and excludes queued and stop-time settlements', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection({ onStart({ agentId, emit }) {
    const state = root({ agentId, phase: 'executing', children: [child({ phase: 'executing', taskState: { inputAt: 100 } })] });
    emit(state); return state;
  }, onStop(agentId) {
    connection.emit(root({ agentId, phase: 'stopping', runMetrics: metrics(95), children: [child({ runMetrics: metrics(98) })] }));
  } });
  let readCount = 0;
  const connect = async () => {
    const client = await connection.connect();
    return { ...client, async prepare() {
      const session = await client.prepare();
      return { ...session, async read() {
        if (++readCount === 1) return session.read();
        connection.emit(root({ agentId: 'sample-main-1', phase: 'executing', runMetrics: metrics(50),
          children: [child({ phase: 'executing', runMetrics: metrics(60) })] }));
        return new Promise(() => {});
      } };
    } };
  };
  const run = createModelBenchmarkRunner({ connect, settleMs: 0, pollIntervalMs: 1, ioTimeoutMs: 100 });
  const [record] = await run(options(outputDir, { timeoutMs: 25 }));
  assert.equal(record.termination, 'timeout');
  assert.equal(record.collectionCoverage, 'partial');
  assert.deepEqual(record.agents[0].runMetrics, metrics(4));
  assert.deepEqual(record.agents[1].runMetrics, metrics(6));
  assert.match(record.agents[0].coverageNote, /before the deadline/);
  assert.deepEqual(connection.stops, ['sample-main-1']);
  await assertArtifacts(outputDir, [record]);
});

test('stop failures are explicit partial records and do not stop unrelated agents', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection({ onStop() { throw new Error('Sample cleanup error'); } });
  const [record] = await runner(connection)(options(outputDir));
  assert.equal(record.termination, 'failed');
  assert.equal(record.collectionCoverage, 'partial');
  assert.match(record.error, /Sample cleanup error/);
  assert.deepEqual(connection.stops, ['sample-main-1']);
  assert.equal(connection.listeners.size, 0);
  await assertArtifacts(outputDir, [record]);
});

test('AbortSignal saves the current cancelled run, skips later scenarios, and removes listeners', async (t) => {
  const outputDir = await directory(t);
  const cancellation = new AbortController();
  const beforeSignals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
  const connection = fakeConnection({ onStart({ agentId, emit }) {
    const state = root({ agentId, phase: 'executing' }); emit(state);
    setTimeout(() => cancellation.abort('Sample cancellation'), 5);
    return state;
  } });
  const records = await runner(connection)(options(outputDir, { signal: cancellation.signal, scenarioIds: ['sample-one', 'sample-two'] }));
  assert.equal(records.length, 1);
  assert.equal(records[0].termination, 'cancelled');
  assert.match(records[0].error, /Sample cancellation/);
  assert.deepEqual(connection.stops, ['sample-main-1']);
  assert.equal(connection.disconnects, 1);
  assert.equal(connection.listeners.size, 0);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)), beforeSignals);
  await assertArtifacts(outputDir, records);
});

test('SIGINT and SIGTERM trigger owned-run cleanup and cancelled artifacts', async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const outputDir = await directory(t);
    const beforeSignals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
    const connection = fakeConnection({ onStart({ agentId, emit }) {
      const state = root({ agentId, phase: 'executing' }); emit(state);
      setTimeout(() => process.emit(signal), 5);
      return state;
    } });
    const records = await runner(connection)(options(outputDir, { repeats: 2 }));
    assert.equal(records.length, 1);
    assert.equal(records[0].termination, 'cancelled');
    assert.deepEqual(connection.stops, ['sample-main-1']);
    assert.equal(connection.listeners.size, 0);
    assert.equal(connection.disconnects, 1);
    assert.deepEqual(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)), beforeSignals);
    await assertArtifacts(outputDir, records);
  }
});

test('already aborted runs are inert, including dependency connection', async (t) => {
  const outputDir = await directory(t);
  const run = createModelBenchmarkRunner({ connect: () => assert.fail('Cancelled run must not connect') });
  const records = await run(options(outputDir, { signal: AbortSignal.abort('Sample pre-start cancellation') }));
  assert.deepEqual(records, []);
});

test('a late observer preparation is unsubscribed without launching model work', async (t) => {
  const outputDir = await directory(t);
  let finishPreparation;
  let closed = false;
  const run = createModelBenchmarkRunner({ ioTimeoutMs: 100, connect: async () => ({
    prepare: () => new Promise((resolve) => { finishPreparation = () => resolve({ close: () => { closed = true; } }); }),
    disconnect() {},
  }) });
  const [record] = await run(options(outputDir, { timeoutMs: 15 }));
  assert.equal(record.termination, 'timeout');
  finishPreparation();
  await delay(1);
  assert.equal(closed, true);
  await assertArtifacts(outputDir, [record]);
});

test('renderer expires a pre-start observer even if the calling transport disconnects', async () => {
  let listener;
  let finishRead;
  let unsubscribed = false;
  let starts = 0;
  const api = {
    observeState(callback) { listener = callback; return () => { unsubscribed = true; }; },
    listStates() { return new Promise((resolve) => { finishRead = resolve; }); },
    async start() { starts++; return root(); },
    async conversation() { return { from: 0, entries: [], total: 0 }; },
    async stop() {},
  };
  const session = createAgentSession(api);
  const prepared = session.prepare(5);
  assert.equal(typeof listener, 'function');
  await delay(10);
  assert.equal(unsubscribed, true);
  finishRead({});
  await assert.rejects(prepared, /preparation expired/);
  await assert.rejects(session.start({}), /closed before agent start/);
  assert.equal(starts, 0);
  session.close();
});

test('conversation pagination discovers missing workers before declaring collection complete', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection({ onStart({ agentId, emit }) { const state = root({ agentId }); emit(state); return state; } });
  const requests = [];
  const entries = Array.from({ length: 500 }, () => ({ t: 'msg', role: 'assistant', content: 'Sample progress.' }));
  entries.push({ t: 'marker', key: 'child_created', value: { id: 'sample-missed', config: { type: 'browser-worker' } } });
  connection.api.conversation = async (_id, page) => {
    requests.push(page);
    return { from: page.from, entries: entries.slice(page.from, page.from + page.limit), total: entries.length };
  };
  const [record] = await runner(connection)(options(outputDir));
  assert.deepEqual(requests.map((page) => page.from), [0, 500]);
  assert.ok(requests.every((page) => page.limit === 500));
  assert.equal(record.termination, 'completed');
  assert.equal(record.collectionCoverage, 'partial');
  assert.equal(record.agents[1].runMetrics, null);
  assert.equal(record.agents[1].currentModel, null);
  await assertArtifacts(outputDir, [record]);
});

test('fixture creation and evaluation failures are saved without suppressing later attempts', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection();
  const site = fixture();
  const create = site.createRun;
  let created = 0;
  site.createRun = (input) => { if (++created === 1) throw new Error('Sample fixture failed'); return create(input); };
  site.evaluateRun = () => { throw new Error('Sample oracle failed'); };
  const records = await runner(connection)(options(outputDir, { fixture: site, repeats: 2 }));
  assert.equal(records.length, 2);
  assert.match(records[0].error, /fixture failed/);
  assert.equal(records[0].result.status, 'failed');
  assert.match(records[1].error, /oracle failed/);
  assert.equal(records[1].result.status, 'failed');
  assert.equal(connection.starts.length, 1);
  await assertArtifacts(outputDir, records);
});

test('failed final metric drain still attempts to stop the owned run', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection();
  const connect = async () => {
    const client = await connection.connect();
    return { ...client, async prepare() {
      const session = await client.prepare();
      return { ...session, drain() { throw new Error('Sample drain failed'); } };
    } };
  };
  const run = createModelBenchmarkRunner({ connect, settleMs: 0, pollIntervalMs: 1, ioTimeoutMs: 100 });
  const [record] = await run(options(outputDir));
  assert.deepEqual(connection.stops, ['sample-main-1']);
  assert.equal(record.collectionCoverage, 'partial');
  assert.match(record.error, /Sample drain failed/);
  await assertArtifacts(outputDir, [record]);
});

test('an existing raw run file is never overwritten and collision fails before another launch', async (t) => {
  const outputDir = await directory(t);
  const connection = fakeConnection();
  const [record] = await runner(connection)(options(outputDir));
  const before = await readFile(join(outputDir, 'records', `${record.runId}.json`), 'utf8');
  await assert.rejects(runner(connection)(options(outputDir)), { code: 'EEXIST' });
  assert.equal(connection.starts.length, 1);
  assert.equal(await readFile(join(outputDir, 'records', `${record.runId}.json`), 'utf8'), before);
});
