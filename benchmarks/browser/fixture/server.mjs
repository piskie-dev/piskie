import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SUITE_ID, SUITE_VERSION, scenarios, getScenario } from './scenarios.mjs';
import { HttpError, validateRunInput, createState, applyAction, listInventory, readRoutes, probeConnector, completeScan, allowDomain } from './model.mjs';
import { evaluateBusinessRun } from './oracle.mjs';

const webRoot = new URL('./web/', import.meta.url);
const attachmentPath = fileURLToPath(new URL('./data/parcel-note.txt', import.meta.url));
const assets = new Map([
  ['/assets/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/components.mjs', ['components.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Use application/json.');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new HttpError(413, 'The request exceeds 64 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
}

export async function startFixtureServer({ host = '127.0.0.1', port = 0, seed = 1 } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new HttpError(400, 'The fixture must bind to a loopback host.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HttpError(400, 'Invalid server port.');
  validateRunInput({ scenarioId: 'intake', seed });
  const runs = new Map();
  const stop = new AbortController();
  let baseUrl;
  const requireRun = (runId) => {
    const run = runs.get(runId);
    if (!run) throw new HttpError(404, 'The workspace run does not exist.');
    return run;
  };
  function createRun(input) {
    const { scenarioId, seed: runSeed } = validateRunInput(input);
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const url = `${baseUrl}/workspace?runId=${runId}`;
    const task = getScenario(scenarioId).task.replaceAll('{{url}}', url).replaceAll('{{attachmentPath}}', attachmentPath);
    runs.set(runId, { runId, scenarioId, seed: runSeed, createdAt, updatedAt: createdAt, state: createState(runSeed), events: [] });
    return { runId, scenarioId, seed: runSeed, url, task, createdAt };
  }
  const getRun = (runId) => structuredClone(requireRun(runId));
  const evaluateRun = (runId) => evaluateBusinessRun(requireRun(runId));
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const wait = (milliseconds) => delay(milliseconds, undefined, { signal: stop.signal });
  const runDelay = (run) => 90 + (Math.imul(run.seed, 17) >>> 0) % 180;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(baseUrl).host) throw new HttpError(403, 'The request host must match the local fixture.');
      if (request.headers.origin && request.headers.origin !== baseUrl) throw new HttpError(403, 'Cross-origin requests are not accepted.');
      const url = new URL(request.url, baseUrl);
      const method = request.method;
      if (method === 'GET' && url.pathname === '/api/scenarios') return json(response, 200, { suiteId: SUITE_ID, suiteVersion: SUITE_VERSION, scenarios });
      if (method === 'POST' && url.pathname === '/api/runs') return json(response, 201, createRun(await readJson(request)));
      if (method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const match = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (match) {
        const run = requireRun(match[1]);
        const resource = match[2] ?? '';
        if (method === 'GET' && !resource) return json(response, 200, getRun(run.runId));
        if (method === 'GET' && resource === 'result') return json(response, 200, evaluateRun(run.runId));
        if (method === 'GET' && resource === 'workspace') {
          await wait(runDelay(run));
          return json(response, 200, { scenarioId: run.scenarioId, state: structuredClone(run.state) });
        }
        if (method === 'POST' && resource === 'actions') {
          const input = await readJson(request);
          await wait(runDelay(run));
          return json(response, 200, { result: applyAction(run, input) });
        }
        if (method === 'GET' && resource === 'inventory') {
          const allowed = new Set(['query', 'region', 'availability', 'page']);
          for (const [key] of url.searchParams) if (!allowed.has(key) || url.searchParams.getAll(key).length > 1) throw new HttpError(400, `Invalid inventory query parameter: ${key}.`);
          const parameters = { query: url.searchParams.get('query') ?? '', region: url.searchParams.get('region') ?? 'All', availability: url.searchParams.get('availability') ?? 'All', page: Number(url.searchParams.get('page') ?? '1') };
          await wait(runDelay(run));
          return json(response, 200, listInventory(run, parameters));
        }
        if (method === 'GET' && resource === 'routes') { await wait(runDelay(run)); return json(response, 200, { routes: readRoutes(run) }); }
        if (method === 'GET' && resource === 'connector') {
          await wait(runDelay(run) * 2);
          const result = probeConnector(run);
          response.setHeader('X-Demo-Trace', result.traceId);
          return json(response, result.status, result);
        }
        if (method === 'GET' && resource.startsWith('scan/')) {
          allowDomain(run, 'diagnostics');
          const scanId = resource.slice(5);
          if (!run.state.diagnostics.scans.some((scan) => scan.id === scanId)) throw new HttpError(404, 'The latency scan does not exist.');
          await wait(5000 + runDelay(run));
          return json(response, 200, completeScan(run, scanId));
        }
        throw new HttpError(404, 'The business endpoint does not exist.');
      }
      if (method === 'GET' && assets.has(url.pathname)) {
        const [filename, contentType] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(await readFile(new URL(filename, webRoot)));
        return;
      }
      if (method === 'GET' && ['/', '/workspace', '/frame'].includes(url.pathname)) {
        if (url.pathname !== '/') requireRun(url.searchParams.get('runId'));
        if (url.pathname === '/frame' && !['outer', 'inner'].includes(url.searchParams.get('level'))) throw new HttpError(400, 'Invalid frame level.');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(await readFile(new URL('index.html', webRoot)));
        return;
      }
      throw new HttpError(404, 'This page does not exist.');
    } catch (error) {
      if (stop.signal.aborted || response.destroyed) return;
      json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'The local fixture could not process this request.' });
    }
  });
  const bindHost = host === 'localhost' ? '127.0.0.1' : host;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => { server.off('error', reject); resolve(); });
  });
  baseUrl = `http://${bindHost === '::1' ? '[::1]' : bindHost}:${server.address().port}`;
  let closing;
  return {
    baseUrl, createRun, getRun, evaluateRun,
    close() {
      if (!closing) {
        stop.abort();
        closing = new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
      }
      return closing;
    },
  };
}
