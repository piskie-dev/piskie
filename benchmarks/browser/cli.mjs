#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { collectEnvironment } from './runner/environment.mjs';
import { SUITE_ID, SUITE_VERSION, scenarios } from './fixture/scenarios.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const usage = `Browser operations benchmark (Node 24+)

  npm run bench:browser -- list
  npm run bench:browser -- serve [--port 4175] [--seed 1]
  npm run bench:browser -- smoke --chromium /path/to/chrome --output-dir /tmp/browser-smoke
  npm run bench:browser -- run --model provider::model --output-dir /tmp/browser-model
  npm run bench:browser -- report --input /tmp/browser-model [--baseline /tmp/browser-before]

Shared options:
  --scenario ID       Repeat or comma-separate; default: all eight scenarios
  --seed N            Deterministic dataset seed, default: 1
  --repeats N         Independent attempts per scenario, default: 1
  --variant NAME      Label the implementation under test, default: working-tree
  --output-dir PATH   Reports/records/profiles/screenshots; default: new OS temporary directory
  --allow-missing-console  Accept unavailable console events in fingerprint browsers; annotate reports

Model options:
  --model ID          Coordinator model reference, providerId::modelId; records actual worker models
  --cdp-url URL       Existing Piskie renderer debugging endpoint, default: http://127.0.0.1:9223
  --timeout-ms N      Per-scenario wall-clock deadline, default: 180000
  --runtime-label ID  Identify the application build you started; default: unknown

Smoke options:
  --chromium PATH     Chromium executable, or FP_CHROMIUM_PATH
  --headed           Show the isolated smoke browser (default: headless)

Report options:
  --input PATH        Repeat for raw JSON/JSONL, report.json, or run directories
  --baseline PATH    Repeat for comparison records

The run command starts real model work in an existing application and uses its configured providers.
It does not restart the application or change model preferences. Smoke has no model tokens or tok/s.
`;

function integer(value, name, fallback, minimum = 1) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return number;
}

function selectedScenarios(values) {
  const ids = values?.flatMap((value) => value.split(',')).filter(Boolean) ?? scenarios.map((scenario) => scenario.id);
  for (const id of ids) if (!scenarios.some((scenario) => scenario.id === id)) throw new Error(`Unknown scenario: ${id}`);
  if (!ids.length) throw new Error('Select at least one scenario');
  return [...new Set(ids)];
}

async function outputDirectory(value) {
  if (value) {
    const directory = resolve(value);
    await mkdir(directory, { recursive: true });
    return directory;
  }
  return mkdtemp(join(tmpdir(), 'browser-operations-'));
}

/** Read only record files, never profiles or screenshots. A run directory owns a records/ folder. */
export async function readRecords(input) {
  const location = resolve(input);
  if ((await stat(location)).isDirectory()) {
    const entries = await readdir(location, { withFileTypes: true });
    const recordsDirectory = entries.find((entry) => entry.name === 'records' && entry.isDirectory());
    if (recordsDirectory) return readRecords(join(location, 'records'));
    const rawFiles = entries.filter((entry) => entry.isFile() && /\.jsonl?$/.test(entry.name) && entry.name !== 'report.json');
    if (rawFiles.length) return (await Promise.all(rawFiles.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => readRecords(join(location, entry.name))))).flat();
    if (entries.some((entry) => entry.name === 'report.json')) return readRecords(join(location, 'report.json'));
    throw new Error(`No records found in ${location}`);
  }
  const text = await readFile(location, 'utf8');
  const values = location.endsWith('.jsonl') ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : [JSON.parse(text)];
  const records = values.flatMap((value) => Array.isArray(value) ? value : Array.isArray(value.records) ? value.records : [value]);
  if (!records.length || records.some((record) => record?.schemaVersion !== 1 || !record.runId)) throw new Error(`Expected benchmark records in ${location}`);
  return records;
}

function uniqueRecords(records) {
  const seen = new Set();
  for (const record of records) {
    const key = `${record.suite?.id}/${record.suite?.version}/${record.execution}/${record.runId}`;
    if (seen.has(key)) throw new Error(`Duplicate runId in report inputs: ${record.runId}`);
    seen.add(key);
  }
  return records;
}

async function writeRawRecord(directory, record) {
  await mkdir(join(directory, 'records'), { recursive: true });
  const safeId = record.runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  await writeFile(join(directory, 'records', `${safeId}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, seed: { type: 'string' },
    scenario: { type: 'string', multiple: true }, repeats: { type: 'string' }, variant: { type: 'string' },
    'output-dir': { type: 'string' }, chromium: { type: 'string' }, headed: { type: 'boolean' },
    model: { type: 'string' }, 'cdp-url': { type: 'string' }, 'timeout-ms': { type: 'string' },
    'runtime-label': { type: 'string' }, 'allow-missing-console': { type: 'boolean' }, input: { type: 'string', multiple: true }, baseline: { type: 'string', multiple: true },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(usage); return; }
  if (positionals.length > 1) throw new Error('Use named options after the command');
  if (!['list', 'serve', 'smoke', 'run', 'report'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'list') {
    console.log(JSON.stringify({ suite: { id: SUITE_ID, version: SUITE_VERSION }, scenarios }, null, 2));
    return;
  }
  const { writeReport, summarizeRecords } = await import('./reporting/index.mjs');
  if (command === 'report') {
    if (!values.input?.length) throw new Error('report requires --input');
    const records = uniqueRecords((await Promise.all(values.input.map(readRecords))).flat());
    const baselineRecords = uniqueRecords((await Promise.all((values.baseline ?? []).map(readRecords))).flat());
    const outputDir = await outputDirectory(values['output-dir']);
    console.log(JSON.stringify(await writeReport(records, { outputDir, baselineRecords }), null, 2));
    return;
  }

  const scenarioIds = selectedScenarios(values.scenario);
  const seed = integer(values.seed, '--seed', 1, 0);
  const repeats = integer(values.repeats, '--repeats', 1);
  const timeoutMs = integer(values['timeout-ms'], '--timeout-ms', 180_000);
  const port = integer(values.port, '--port', command === 'serve' ? 4175 : 0, 0);
  if (port > 65535) throw new Error('--port must be <= 65535');
  if (command === 'run' && !/^[^:]+::[^:]+$/.test(values.model ?? '')) throw new Error('run requires --model providerId::modelId');
  const chromium = values.chromium ?? process.env.FP_CHROMIUM_PATH;
  if (command === 'smoke' && !chromium) throw new Error('smoke requires --chromium or FP_CHROMIUM_PATH');
  if (command === 'smoke') await stat(resolve(chromium));
  const { startFixtureServer } = await import('./fixture/server.mjs');
  const fixture = await startFixtureServer({ port, seed });
  if (command === 'serve') {
    console.log(`Browser benchmark: ${fixture.baseUrl}\nCreate a fresh task in the scenario launcher. Press Ctrl+C to stop.`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await fixture.close();
      process.exitCode = 0;
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }

  let browser;
  try {
    const outputDir = await outputDirectory(values['output-dir']);
    const variant = values.variant ?? 'working-tree';
    let records;
    if (command === 'smoke') {
      const { default: puppeteer } = await import('puppeteer-core');
      const { runFixtureSmoke } = await import('./fixture/smoke.mjs');
      const profile = await mkdtemp(join(outputDir, 'profile-'));
      browser = await puppeteer.launch({ executablePath: resolve(chromium), headless: !values.headed, userDataDir: profile,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
        defaultViewport: { width: 1440, height: 1000 },
      });
      const environment = await collectEnvironment({ workspace, runner: 'puppeteer-ui', browser: await browser.version(), browserExecutable: resolve(chromium), viewport: { width: 1440, height: 1000 }, runtimeLabel: 'source-fixture' });
      environment.consoleEvidencePolicy = values['allow-missing-console'] ? 'optional' : 'required';
      records = [];
      for (let attempt = 1; attempt <= repeats; attempt++) {
        const results = await runFixtureSmoke({ baseUrl: fixture.baseUrl, browser, artifactDir: join(outputDir, `screenshots-${attempt}`), scenarioIds, seed, allowMissingConsole: values['allow-missing-console'] === true });
        for (const [index, item] of results.entries()) {
          const result = item.result?.checks ? item.result : { status: 'failed', checks: [{ id: 'oracle.available', passed: false, expected: 'Independent business result', actual: null }], completedAt: item.endedAt };
          const record = {
            schemaVersion: 1, suite: { id: SUITE_ID, version: SUITE_VERSION },
            runId: item.run?.runId ?? randomUUID(), scenarioId: item.run?.scenarioId ?? scenarioIds[index], seed, attempt, variant, execution: 'scripted',
            startedAt: item.startedAt, endedAt: item.endedAt, wallTimeMs: item.wallTimeMs,
            termination: item.error ? 'failed' : 'completed', environment, requestedModel: null,
            result, artifacts: item.artifacts, capabilityNotes: item.capabilityNotes, ...(item.error ? { error: String(item.error) } : {}),
          };
          records.push(record);
          await writeRawRecord(outputDir, record);
          console.log(`${record.scenarioId}: ${summarizeRecords([record]).overall.passed ? 'passed' : 'failed'} (oracle: ${record.result.status}, ${Math.round(record.wallTimeMs)} ms)`);
        }
      }
    } else {
      const { runModelBenchmark } = await import('./runner/piskie.mjs');
      const environment = await collectEnvironment({ workspace, runner: 'piskie-app-cdp', runtimeLabel: values['runtime-label'] ?? 'unknown' });
      environment.consoleEvidencePolicy = values['allow-missing-console'] ? 'optional' : 'required';
      records = await runModelBenchmark({ fixture, scenarioIds, model: values.model, variant, repeats, seed, timeoutMs,
        cdpUrl: values['cdp-url'] ?? 'http://127.0.0.1:9223', workspace, environment, outputDir,
        onRecord: (record) => console.log(`${record.scenarioId}: ${summarizeRecords([record]).overall.passed ? 'passed' : 'failed'} (${record.termination}, ${Math.round(record.wallTimeMs)} ms)`),
      });
    }
    const paths = await writeReport(records, { outputDir });
    const summary = summarizeRecords(records).overall;
    console.log(JSON.stringify({ attempts: summary.attempts, passed: summary.passed, ...paths }, null, 2));
    if (summary.passed !== summary.attempts) process.exitCode = 1;
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Browser benchmark: ${error.message}`); process.exitCode = 1; });
}
