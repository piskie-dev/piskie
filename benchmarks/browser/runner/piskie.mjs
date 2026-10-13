import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const REQUIRED_METHODS = ['start', 'observeState', 'listStates', 'conversation', 'stop'];
const TERMINAL_NOTIFICATIONS = new Set(['completed', 'failed', 'user_stopped']);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const message = (error) => error instanceof Error ? error.message : String(error);

export function assertLocalUrl(value, label = 'URL', protocols = ['http:', 'https:']) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute localhost URL`); }
  if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) {
    throw new TypeError(`${label} must use localhost, 127.0.0.1, or [::1] without credentials`);
  }
  return url;
}

export function validateBenchmarkOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Benchmark options are required');
  const { fixture, scenarioIds, model = null, variant, repeats = 1, seed = 1, timeoutMs = 180_000,
    cdpUrl = 'http://127.0.0.1:9223', workspace, environment, outputDir, onRecord, signal } = options;
  if (!fixture || ['createRun', 'evaluateRun', 'getRun'].some((key) => typeof fixture[key] !== 'function')) {
    throw new TypeError('fixture must expose createRun, evaluateRun, and getRun');
  }
  assertLocalUrl(fixture.baseUrl, 'fixture.baseUrl');
  if (!Array.isArray(scenarioIds) || !scenarioIds.length || scenarioIds.some((id) => !text(id))) {
    throw new TypeError('scenarioIds must be a nonempty array of scenario IDs');
  }
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new TypeError('scenarioIds must be unique');
  if (model !== null && (!text(model) || model.length > 512 || model !== model.trim()
    || model.indexOf('::') <= 0 || model.indexOf('::') === model.length - 2)) {
    throw new TypeError('model must use providerId::modelId, or be null to use the application default');
  }
  if (!text(variant)) throw new TypeError('variant must be a nonempty label');
  for (const [name, value, minimum] of [['repeats', repeats, 1], ['seed', seed, 0], ['timeoutMs', timeoutMs, 1]]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  if (timeoutMs > 2_147_483_647) throw new TypeError('timeoutMs exceeds the Node timer range');
  assertLocalUrl(cdpUrl, 'cdpUrl');
  if (workspace !== undefined && (!text(workspace) || !isAbsolute(workspace))) throw new TypeError('workspace must be an absolute path');
  if (!text(outputDir)) throw new TypeError('outputDir is required');
  if (onRecord !== undefined && typeof onRecord !== 'function') throw new TypeError('onRecord must be a function');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('environment is required');
  for (const field of ['revision', 'diffHash', 'node', 'platform']) {
    if (environment[field] !== null && !text(environment[field])) throw new TypeError(`environment.${field} must be text or null`);
  }
  if (typeof environment.dirty !== 'boolean') throw new TypeError('environment.dirty must be boolean');
  if (environment.browser !== null && !text(environment.browser)
    && (!environment.browser || typeof environment.browser !== 'object' || Array.isArray(environment.browser))) throw new TypeError('environment.browser must be text, an object, or null');
  if (environment.viewport !== null && (!environment.viewport
    || !['width', 'height'].every((key) => Number.isSafeInteger(environment.viewport[key]) && environment.viewport[key] > 0))) {
    throw new TypeError('environment.viewport must be a positive width/height pair or null');
  }
  const consoleEvidencePolicy = environment.consoleEvidencePolicy ?? 'required';
  if (!['required', 'optional'].includes(consoleEvidencePolicy)) throw new TypeError('environment.consoleEvidencePolicy must be required or optional');
  // Only caller-supplied benchmark metadata is serialized; no application configuration is read.
  const metadata = JSON.parse(JSON.stringify({ ...environment, consoleEvidencePolicy }));
  return { fixture, scenarioIds: [...scenarioIds], model, variant, repeats, seed, timeoutMs, cdpUrl,
    workspace, environment: metadata, outputDir: resolve(outputDir), onRecord, signal };
}

export function buildBenchmarkPrompt(run, baseUrl, { allowMissingConsole = false } = {}) {
  const url = assertLocalUrl(run.url, 'run.url');
  if (url.origin !== new URL(baseUrl).origin) throw new TypeError('The task URL must belong to the fixture server');
  if (!text(run.task)) throw new TypeError('The fixture must provide a business task');
  if (/\{\{(?:url|attachmentPath)\}\}/.test(run.task)) throw new TypeError('The fixture task contains an unresolved URL or attachment placeholder');
  return [
    'Complete this task using a Browser Worker and the real browser UI. Use a fresh temporary browser for this task.',
    'Read visible page content and use the UI controls; browser console and network observations may be used when the task asks for them.',
    'Do not call business or evaluation HTTP endpoints directly, or change application state through scripts, files, or storage. Use the supplied local attachment through the upload control when requested.',
    `Task page: ${url.href}`,
    run.task,
    ...(allowMissingConsole && run.scenarioId === 'diagnostics' ? [
      'If this fingerprint browser does not expose console events, use browser network observations to verify the original failed request’s error code and trace ID, then continue the repair. State in your completion feedback that console evidence was unavailable. Do not invent console evidence. All other task requirements still apply.',
    ] : []),
    'After completing the task, report the result you verified in the UI. If blocked, report the blocker and what remains unfinished.',
  ].join('\n\n');
}

export function isQuiescent(state) {
  return Boolean(state && state.phase === 'waiting' && !state.pendingQuestion && !state.pendingToolCall
    && (Array.isArray(state.pendingEvents) ? state.pendingEvents.length === 0 : state.pendingEvents === 0)
    && state.activeStartedAt == null && state.activeLlmStartedAt == null && state.activeToolPhaseStartedAt == null
    && (!state.aiRequestState || state.aiRequestState.phase === 'finished'));
}

/** Retain only observed live metrics. Removed children and model changes survive later snapshots. */
export function createStateCollector(agentId) {
  const entries = new Map();
  let root = null;
  let released = false;
  let finalAssistant = false;
  let conversationComplete = false;
  let streamObserved = false;
  let rootTerminalCaptured = false;
  const collectionNotes = new Set();

  function ensure(id, parentAgentId, agentType) {
    if (!entries.has(id)) entries.set(id, { agentId: id, parentAgentId, agentType,
      currentModel: null, modelsObserved: [], runMetrics: null, terminalCaptured: false, present: false });
    const item = entries.get(id);
    if (agentType) item.agentType = agentType;
    return item;
  }

  function observe(state, id, parentAgentId, type) {
    const item = ensure(id, parentAgentId, type);
    item.present = true;
    item.state = structuredClone(state);
    if (text(state.currentModel)) {
      item.currentModel = state.currentModel;
      if (!item.modelsObserved.includes(state.currentModel)) item.modelsObserved.push(state.currentModel);
    }
    if (state.runMetrics != null) item.runMetrics = structuredClone(state.runMetrics);
    if (parentAgentId !== null) {
      const notification = state.taskState?.notification;
      item.terminalCaptured = isQuiescent(state) && TERMINAL_NOTIFICATIONS.has(notification?.type);
    }
    return item;
  }

  return {
    ingest(event) {
      if (event.agentId !== agentId) return;
      if (event.source === 'observer') streamObserved = true;
      if (!event.state) { released = true; return; }
      released = false;
      root = structuredClone(event.state);
      observe(root, agentId, null, root.agentSpec || 'director');
      const present = new Set();
      for (const child of root.children ?? []) {
        present.add(child.id);
        observe(child, child.id, agentId, child.type || 'unknown');
      }
      for (const item of entries.values()) if (item.parentAgentId === agentId && !present.has(item.agentId)) item.present = false;
    },
    conversation(page) {
      if (!page) return;
      for (const entry of page.entries) {
        if (entry.kind === 'turn') finalAssistant = entry.finalAssistant;
        if (entry.kind === 'child') ensure(entry.agentId, agentId, entry.agentType || 'unknown');
      }
      conversationComplete = page.complete;
    },
    note(value) { collectionNotes.add(value); },
    outcome() {
      if (released || root?.interrupted) return 'cancelled';
      if (!isQuiescent(root)) return null;
      if (root.aiRequestState?.outcome === 'failed') return 'failed';
      if (root.aiRequestState?.outcome === 'cancelled') return 'cancelled';
      if (!conversationComplete || !finalAssistant) return null;
      if ([...entries.values()].some((item) => item.parentAgentId !== null && item.present && !isQuiescent(item.state))) return null;
      return 'completed';
    },
    captureTermination() {
      rootTerminalCaptured = isQuiescent(root) && this.outcome() !== null;
    },
    result() {
      const agents = [...entries.values()].map((item) => {
        const notes = [...collectionNotes];
        if (!streamObserved) notes.push('No live observer event was received for this run; only start/listStates snapshots were available.');
        if (item.runMetrics === null) notes.push('Live runMetrics were not captured.');
        if (!(item.parentAgentId === null ? rootTerminalCaptured : item.terminalCaptured)) {
          notes.push(item.parentAgentId === null ? 'The parent terminal metrics were not confirmed.'
            : 'The worker terminal notification and a subsequent quiescent metrics snapshot were not both captured.');
        }
        if (item.modelsObserved.length > 1) notes.push('Metrics accumulate across the observed models and cannot be split by model.');
        return { agentId: item.agentId, parentAgentId: item.parentAgentId, agentType: item.agentType,
          currentModel: item.currentModel, modelsObserved: [...item.modelsObserved], runMetrics: structuredClone(item.runMetrics),
          ...(notes.length ? { coverageNote: notes.join(' ') } : {}) };
      });
      const measured = agents.some((item) => item.runMetrics !== null);
      const complete = measured && streamObserved && conversationComplete && !collectionNotes.size && rootTerminalCaptured
        && [...entries.values()].every((item) => item.runMetrics !== null && (item.parentAgentId === null || item.terminalCaptured));
      return { agents, collectionCoverage: complete ? 'complete' : measured ? 'partial' : 'none' };
    },
  };
}

/**
 * Self-contained renderer-side adapter, also usable with a fake public AgentClient in tests.
 * Unsubscribe functions stay in the renderer. Only measurement fields cross CDP.
 */
export function createAgentSession(api) {
  const methods = ['start', 'observeState', 'listStates', 'conversation', 'stop'];
  const missing = methods.filter((name) => typeof api?.[name] !== 'function');
  if (missing.length) throw new Error(`Piskie Agent API unavailable: ${missing.join(', ')}`);
  let ownedId = null;
  let sequence = 0;
  let events = [];
  let cursor = 0;
  let closing = false;
  let unsubscribe;
  let startPromise;
  let startSettled = false;
  let stopPromise;
  let preparationTimer;
  let baseline = new Set();

  function project(state, child = false) {
    if (!state) return null;
    const result = {
      ...(child ? { id: state.id, type: state.type } : { agentId: state.agentId, agentSpec: state.agentSpec }),
      phase: state.phase, currentModel: state.currentModel ?? null, runMetrics: state.runMetrics ?? null,
      interrupted: state.interrupted === true, pendingQuestion: Boolean(state.pendingQuestion),
      pendingToolCall: Boolean(state.pendingToolCall), pendingEvents: state.pendingEvents.length,
      activeStartedAt: state.activeStartedAt ?? null, activeLlmStartedAt: state.activeLlmStartedAt ?? null,
      activeToolPhaseStartedAt: state.activeToolPhaseStartedAt ?? null,
      aiRequestState: state.aiRequestState ? { phase: state.aiRequestState.phase, outcome: state.aiRequestState.outcome ?? null } : null,
    };
    if (child) result.taskState = state.taskState ? {
      inputAt: state.taskState.inputAt,
      ...(state.taskState.notification ? { notification: { ...state.taskState.notification } } : {}),
    } : null;
    else result.children = state.children.map((item) => project(item, true));
    return result;
  }

  function push(event, source) {
    if ((ownedId && event.agentId !== ownedId) || (!ownedId && baseline.has(event.agentId))) return;
    sequence++;
    events.push({ agentId: event.agentId, state: project(event.state), source });
  }

  function drain() {
    const batch = ownedId ? events.filter((event) => event.agentId === ownedId) : [];
    events = [];
    return { events: batch };
  }

  function stopOwned() {
    if (!stopPromise) stopPromise = Promise.resolve().then(() => api.stop(ownedId));
    return stopPromise;
  }

  return {
    async prepare(timeoutMs) {
      // Register first, then issue a read on the same public transport before starting work.
      unsubscribe = api.observeState((event) => push(event, 'observer'));
      if (timeoutMs !== undefined) preparationTimer = setTimeout(() => {
        closing = true;
        unsubscribe();
        events = [];
      }, timeoutMs);
      try {
        baseline = new Set(Object.keys(await api.listStates()));
        if (closing) throw new Error('Observer preparation expired before agent start');
        events = events.filter((event) => !baseline.has(event.agentId));
      } catch (error) { clearTimeout(preparationTimer); unsubscribe(); throw error; }
    },
    async start(request) {
      if (closing) throw new Error('The benchmark session was closed before agent start');
      clearTimeout(preparationTimer);
      startPromise = api.start(request).then(async (state) => {
        ownedId = state.agentId;
        events = events.filter((event) => event.agentId === ownedId);
        // If start outlives the deadline, its eventual result still identifies exactly the run to stop.
        if (closing) await stopOwned();
        return project(state);
      }).finally(() => { startSettled = true; });
      return startPromise;
    },
    async read() {
      if (!ownedId) return drain();
      const before = sequence;
      const states = await api.listStates();
      // An observer update received during the RPC is newer than its potentially stale snapshot.
      if (before === sequence) push({ agentId: ownedId, state: states[ownedId] ?? null }, 'snapshot');
      const page = await api.conversation(ownedId, { direction: 'forward', from: cursor, limit: 500 });
      if (page.from !== cursor) throw new Error('Conversation cursor changed during live collection');
      cursor += page.entries.length;
      const entries = [];
      for (const entry of page.entries) {
        if (entry.t === 'marker' && entry.key === 'child_created' && entry.value?.id) {
          entries.push({ kind: 'child', agentId: entry.value.id, agentType: entry.value.config?.type ?? 'unknown' });
        } else if (entry.t === 'msg') {
          const content = entry.content;
          const hasText = typeof content === 'string' ? content.trim().length > 0
            : Array.isArray(content) && content.some((block) => block.type === 'text' && block.text?.trim());
          const hasTools = Array.isArray(content) && content.some((block) => block.type === 'tool_use');
          entries.push({ kind: 'turn', finalAssistant: entry.role === 'assistant' && hasText && !hasTools });
        } else if (entry.t === 'tool' || entry.t === 'summary') entries.push({ kind: 'turn', finalAssistant: false });
      }
      return { ...drain(), conversation: { entries, complete: cursor >= page.total } };
    },
    drain,
    async stop() {
      closing = true;
      if (ownedId) { await stopOwned(); return { pendingStart: false }; }
      return { pendingStart: Boolean(startPromise) && !startSettled };
    },
    close() { closing = true; clearTimeout(preparationTimer); unsubscribe?.(); events = []; },
  };
}

async function connectPiskie({ cdpUrl, ioTimeoutMs }) {
  // Resolve the only optional runtime dependency before creating any fixture attempt.
  const { default: puppeteer } = await import('puppeteer-core');
  const endpoint = assertLocalUrl(cdpUrl, 'cdpUrl');
  const response = await fetch(new URL('/json/version', endpoint), { redirect: 'error', signal: AbortSignal.timeout(ioTimeoutMs) });
  if (!response.ok) throw new Error(`Piskie CDP discovery returned HTTP ${response.status}`);
  const discovery = await response.json();
  assertLocalUrl(discovery.webSocketDebuggerUrl, 'CDP WebSocket URL', ['ws:', 'wss:']);
  const browser = await puppeteer.connect({ browserWSEndpoint: discovery.webSocketDebuggerUrl,
    defaultViewport: null, protocolTimeout: ioTimeoutMs });
  try {
    const candidates = (await browser.pages()).filter((page) => {
      try { assertLocalUrl(page.url(), 'renderer URL'); return true; } catch { return false; }
    });
    let renderer;
    const missingApis = [];
    for (const page of candidates) {
      const status = await page.evaluate((methods) => ({
        electron: window.piskie?.runtime?.host === 'electron',
        missing: methods.filter((name) => typeof window.piskie?.agents?.[name] !== 'function'),
      }), REQUIRED_METHODS);
      if (status.electron && !status.missing.length) { renderer = page; break; }
      missingApis.push(...status.missing);
    }
    if (!renderer) throw new Error(`No localhost Piskie Electron renderer with the required Agent API was found${missingApis.length ? ` (missing: ${[...new Set(missingApis)].join(', ')})` : ''}`);
    return {
      async prepare({ timeoutMs = ioTimeoutMs } = {}) {
        const key = `__piskieBrowserBenchmark_${randomUUID().replaceAll('-', '')}`;
        // This expression contains only our function and a generated property name, never task input.
        await renderer.evaluate(`globalThis[${JSON.stringify(key)}] = (${createAgentSession.toString()})(window.piskie.agents); void 0`);
        const invoke = (method, value) => renderer.evaluate(({ key, method, value }) => globalThis[key][method](value), { key, method, value });
        try { await invoke('prepare', Math.min(timeoutMs, ioTimeoutMs)); } catch (error) {
          await renderer.evaluate((key) => { globalThis[key]?.close(); delete globalThis[key]; }, key).catch(() => {});
          throw error;
        }
        return { start: (request) => invoke('start', request), read: () => invoke('read'), drain: () => invoke('drain'), stop: () => invoke('stop'),
          close: () => renderer.evaluate((key) => { globalThis[key]?.close(); delete globalThis[key]; }, key) };
      },
      disconnect: () => browser.disconnect(),
    };
  } catch (error) { await browser.disconnect(); throw error; }
}

class DeadlineError extends Error {
  constructor(label) { super(`${label} timed out`); this.name = 'DeadlineError'; }
}

class CancellationError extends Error {
  constructor(reason) { super(`Benchmark cancelled: ${message(reason ?? 'abort requested')}`); this.name = 'AbortError'; }
}

async function bounded(operation, durationMs, label, signal) {
  if (signal?.aborted) throw new CancellationError(signal.reason);
  if (durationMs <= 0) throw new DeadlineError(label);
  let timer;
  let onAbort;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal?.aborted) throw new CancellationError(signal.reason);
      return operation();
    }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(label)), durationMs);
      onAbort = () => reject(new CancellationError(signal.reason));
      signal?.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

function unavailableResult(error) {
  return { status: 'failed', checks: [{ id: 'oracle-available', passed: false,
    expected: 'Independent fixture evaluation', actual: message(error) }], completedAt: new Date().toISOString() };
}

function consume(collector, batch) {
  for (const event of batch.events) collector.ingest(event);
  collector.conversation(batch.conversation);
}

/** Inject the session transport for tests, without mocking Puppeteer or making model requests. */
export function createModelBenchmarkRunner({ connect = connectPiskie, pollIntervalMs = 200, settleMs = 400, ioTimeoutMs = 10_000 } = {}) {
  return async (input) => {
    const options = validateBenchmarkOptions(input);
    const recordsDir = join(options.outputDir, 'records');
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort('SIGINT');
    const terminate = () => cancellation.abort('SIGTERM');
    const externalAbort = () => cancellation.abort(options.signal.reason);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) externalAbort();
    let connection;
    let failure;
    const records = [];
    try {
      if (cancellation.signal.aborted) return records;
      if (options.workspace && !(await stat(options.workspace)).isDirectory()) throw new TypeError('workspace must be a directory');
      await mkdir(recordsDir, { recursive: true });
      await access(recordsDir, constants.W_OK | constants.X_OK);
      connection = await connect({ cdpUrl: options.cdpUrl, ioTimeoutMs });
      attempts: for (let attempt = 1; attempt <= options.repeats; attempt++) {
        for (const scenarioId of options.scenarioIds) {
          if (cancellation.signal.aborted) break attempts;
          const start = performance.now();
          const startedAt = new Date().toISOString();
          const remaining = () => options.timeoutMs - (performance.now() - start);
          const deadline = (operation) => bounded(operation, remaining(), `Scenario ${scenarioId}`, cancellation.signal);
          let run;
          let session;
          let collector;
          let file;
          const errors = [];
          const record = { schemaVersion: 1, suite: { id: 'browser-operations', version: '1' },
            runId: randomUUID(), scenarioId, seed: options.seed, attempt, variant: options.variant, execution: 'model',
            startedAt, endedAt: startedAt, wallTimeMs: 0, termination: 'failed',
            environment: { ...options.environment, modelSelection: 'initialModel applies to the parent; workers use current preferences or inherit. Actual worker models are collected separately.' },
            requestedModel: options.model, collectionCoverage: 'none', agents: [], result: null };
          try {
            run = await deadline(() => options.fixture.createRun({ scenarioId, seed: options.seed }));
            if (!/^[a-zA-Z0-9_-]+$/.test(run.runId ?? '')) throw new Error('Fixture runId must be a filename-safe unique ID');
            record.runId = run.runId;
            const prompt = buildBenchmarkPrompt(run, options.fixture.baseUrl, {
              allowMissingConsole: options.environment.consoleEvidencePolicy === 'optional',
            });
            // Exclusive reservation fails before spending model tokens, and never overwrites an earlier attempt.
            file = await open(join(recordsDir, `${record.runId}.json`), 'wx');
            let preparationExpired = false;
            const preparation = Promise.resolve().then(() => connection.prepare({ timeoutMs: Math.max(1, remaining()) }));
            void preparation.then((prepared) => {
              if (preparationExpired) return prepared.close();
            }).catch(() => {});
            try { session = await deadline(() => preparation); }
            catch (error) { preparationExpired = true; throw error; }
            const state = await deadline(() => session.start({ modeId: 'normal', input: prompt,
              ...(options.workspace ? { workspace: options.workspace } : {}), approvalMode: 'auto',
              ...(options.model ? { launchOptions: { initialModel: options.model } } : {}) }));
            collector = createStateCollector(state.agentId);
            collector.ingest({ agentId: state.agentId, state, source: 'start' });
            let settledSince = null;
            let previousOutcome = null;
            for (;;) {
              consume(collector, await deadline(() => session.read()));
              const outcome = collector.outcome();
              if (outcome) {
                if (previousOutcome !== outcome) settledSince = performance.now();
                if (performance.now() - settledSince >= settleMs) {
                  record.termination = outcome;
                  collector.captureTermination();
                  break;
                }
              } else settledSince = null;
              previousOutcome = outcome;
              await deadline(() => delay(Math.min(pollIntervalMs, Math.max(1, remaining()))));
            }
          } catch (error) {
            if (error?.code === 'EEXIST') throw error;
            record.termination = error instanceof CancellationError ? 'cancelled' : error instanceof DeadlineError ? 'timeout' : 'failed';
            errors.push(message(error));
            if (collector) collector.note('Collection ended before normal completion.');
          } finally {
            const endedByDeadline = record.termination === 'timeout' || record.termination === 'cancelled';
            if (collector && endedByDeadline) {
              collector.note('Only snapshots consumed before the deadline or cancellation are included.');
            } else if (collector && session) {
              try { consume(collector, await bounded(() => session.drain(), ioTimeoutMs, 'Final state drain')); }
              catch (error) { errors.push(`Final state drain: ${message(error)}`); collector.note('The final live state drain failed.'); }
              collector.captureTermination();
              if (record.termination === 'completed' && collector.outcome() !== 'completed') {
                record.termination = collector.outcome() ?? 'failed';
                errors.push('Agent state changed before the measurement cutoff.');
                collector.note('Activity changed before final metrics could be confirmed.');
              }
            }
            // Freeze measurements before stop: cancellation settlements belong to cleanup, not the task.
            record.wallTimeMs = performance.now() - start;
            record.endedAt = new Date(Date.parse(startedAt) + record.wallTimeMs).toISOString();
            if (collector) Object.assign(record, collector.result());
            const cleanupNote = (note) => {
              if (record.collectionCoverage === 'complete') record.collectionCoverage = 'partial';
              for (const agent of record.agents) agent.coverageNote = [agent.coverageNote, note].filter(Boolean).join(' ');
            };
            if (session) {
              const cleanup = [
                ['Stopping benchmark agent', async () => {
                  const stopped = await session.stop();
                  if (stopped?.pendingStart) errors.push('Start returned no agent ID before collection ended; the renderer will stop this launch if it later returns.');
                }],
                // Drain discarded cleanup events so they cannot overwrite terminal metrics or coverage.
                ['Post-stop state drain', () => session.drain()],
              ];
              for (const [label, operation] of cleanup) {
                try { await bounded(operation, ioTimeoutMs, label); }
                catch (error) {
                  errors.push(`${label}: ${message(error)}`);
                  cleanupNote(`${label} was not confirmed.`);
                  if (label === 'Stopping benchmark agent' && record.termination === 'completed') record.termination = 'failed';
                }
              }
              try { await bounded(() => session.close(), ioTimeoutMs, 'Removing benchmark observer'); }
              catch (error) { errors.push(`Observer cleanup: ${message(error)}`); cleanupNote('Observer cleanup failed.'); }
            }
          }
          try {
            record.result = run ? await bounded(() => options.fixture.evaluateRun(run.runId), ioTimeoutMs, 'Fixture evaluation')
              : unavailableResult(errors.join('; ') || 'Fixture creation failed');
          } catch (error) { record.result = unavailableResult(error); errors.push(`Fixture evaluation: ${message(error)}`); }
          if (errors.length) record.error = errors.join('\n');
          // Every unsuccessful attempt follows the same artifact path and callback as a successful one.
          try {
            file ??= await open(join(recordsDir, `${record.runId}.json`), 'wx');
            await file.writeFile(`${JSON.stringify(record, null, 2)}\n`);
            await file.sync();
          } catch (error) {
            records.push(record);
            throw new Error(`Cannot persist benchmark ${record.runId}: ${message(error)}`, { cause: error });
          } finally { await file?.close(); }
          records.push(record);
          if (options.onRecord) {
            // Notification failures cannot discard records or prevent the remaining scenarios running.
            try { await bounded(() => options.onRecord(structuredClone(record)), ioTimeoutMs, 'onRecord'); }
            catch (error) { record.error = [record.error, `onRecord: ${message(error)}`].filter(Boolean).join('\n');
              const handle = await open(join(recordsDir, `${record.runId}.json`), 'w');
              try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`); } finally { await handle.close(); }
            }
          }
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      try { await connection?.disconnect(); }
      catch (error) {
        failure = failure ? new AggregateError([failure, error], `${message(failure)}; CDP disconnect: ${message(error)}`) : error;
      }
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      options.signal?.removeEventListener('abort', externalAbort);
    }
    if (failure) { failure.records = records; throw failure; }
    return records;
  };
}

/** Start real model work only when explicitly called by the CLI's run command. Importing is inert. */
export async function runModelBenchmark(options) {
  return createModelBenchmarkRunner()(options);
}
