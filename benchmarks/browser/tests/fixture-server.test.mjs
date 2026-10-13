import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startFixtureServer } from '../fixture/server.mjs';
import { scenarios, SUITE_ID, SUITE_VERSION } from '../fixture/scenarios.mjs';

let server;
const intake = { customer: 'Aster Demo Co', contact: 'Riley Demo', email: 'riley@example.invalid', units: 12, service: 'Express', priority: 'High', deliveryDate: '2030-06-18', notes: 'Demo launch allocation', insured: true, terms: true, marketing: false };
const routing = { routeId: 'ROUTE-7', depot: 'harbor', reorder: 24, label: 'Demo coastal lane', coldChain: true };
const receiving = { orderId: 'PO-731', receiver: 'Morgan Demo', seal: 'DEMO-SEAL-731', condition: 'Good', counted: true };
const parcelNote = await readFile(new URL('../fixture/data/parcel-note.txt', import.meta.url), 'utf8');
before(async () => { server = await startFixtureServer(); });
after(async () => { await server?.close(); });

async function json(path, options = {}, status = 200) {
  const response = await fetch(server.baseUrl + path, options);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
const post = (path, body, status = 200) => json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, status);
const action = async (run, type, fields = {}, status = 200) => (await post(`/api/runs/${run.runId}/actions`, { type, ...fields }, status)).result;
const run = (scenarioId, seed = 17) => server.createRun({ scenarioId, seed });
const result = (record) => json(`/api/runs/${record.runId}/result`);
async function allocate(record) {
  await action(record, 'inventory.refresh');
  await json(`/api/runs/${record.runId}/inventory?region=East&availability=Ready&query=DEMO-042`);
  await action(record, 'inventory.reserve', { sku: 'DEMO-042', quantity: 7, customer: 'Aster Demo Co' });
}
async function dispatch(record, content = parcelNote) {
  await action(record, 'board.move', { cardId: 'PAR-104', lane: 'Packed' });
  await action(record, 'board.attach', { cardId: 'PAR-104', name: 'parcel-note.txt', mime: 'text/plain', content });
  await action(record, 'board.move', { cardId: 'PAR-104', lane: 'Dispatched' });
}
async function receive(record) {
  await action(record, 'tabs.confirm', receiving);
  await action(record, 'tabs.reconcile', { orderId: 'PO-731' });
}
async function expectPassed(record) {
  const verdict = await result(record);
  assert.equal(verdict.status, 'passed', JSON.stringify(verdict.checks.filter((check) => !check.passed)));
  assert.ok(verdict.checks.length >= 3);
  assert.ok(verdict.checks.every((check) => check.id && check.passed && Object.hasOwn(check, 'expected') && Object.hasOwn(check, 'actual')));
  assert.ok(Number.isFinite(Date.parse(verdict.completedAt)));
}

test('publishes eight independent tasks and exact runner interfaces', async () => {
  assert.equal(SUITE_ID, 'browser-operations');
  assert.equal(SUITE_VERSION, '1');
  assert.deepEqual(scenarios.map((entry) => entry.id), ['intake', 'inventory', 'approvals', 'board', 'frames', 'tabs', 'diagnostics', 'journey']);
  const catalog = await json('/api/scenarios');
  assert.deepEqual(catalog.scenarios, scenarios);
  const created = await post('/api/runs', { scenarioId: 'board' }, 201);
  assert.deepEqual(Object.keys(created).sort(), ['createdAt', 'runId', 'scenarioId', 'seed', 'task', 'url']);
  assert.equal(created.seed, 1);
  assert.match(created.runId, /^[a-f0-9-]{36}$/);
  assert.equal(new URL(created.url).searchParams.get('runId'), created.runId);
  assert.ok(created.task.includes(created.url));
  assert.ok(created.task.includes('parcel-note.txt'));
  assert.ok(!created.task.includes('{{'));
  const stored = await json(`/api/runs/${created.runId}`);
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'events', 'runId', 'scenarioId', 'seed', 'state', 'updatedAt']);
  assert.equal((await result(created)).status, 'failed');
});

test('empty runs cannot pass and all scenario runs remain independent', async () => {
  for (const scenario of scenarios) {
    const created = run(scenario.id);
    assert.equal(server.evaluateRun(created.runId).status, 'failed', scenario.id);
    assert.deepEqual(server.getRun(created.runId).events, []);
  }
  const first = run('intake');
  const second = run('intake');
  const before = server.getRun(second.runId);
  await action(first, 'intake.submit', intake);
  assert.deepEqual(server.getRun(second.runId), before);
  const detached = server.getRun(first.runId);
  detached.state.intake.submissions.length = 0;
  assert.equal(server.getRun(first.runId).state.intake.submissions.length, 1);
  assert.notEqual(first.runId, second.runId);
});

test('seed repeats generated stock while run IDs remain random', () => {
  const first = run('inventory', 31);
  const second = run('inventory', 31);
  const third = run('inventory', 32);
  assert.deepEqual(server.getRun(first.runId).state, server.getRun(second.runId).state);
  assert.notDeepEqual(server.getRun(first.runId).state.inventory.items, server.getRun(third.runId).state.inventory.items);
  assert.notEqual(first.runId, second.runId);
});

test('intake requires real field values and one submitted request', async () => {
  const created = run('intake');
  await action(created, 'intake.submit', intake);
  await expectPassed(created);
  await action(created, 'intake.submit', intake);
  const verdict = await result(created);
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.checks.find((entry) => entry.id === 'intake.single-submission').actual, 2);
  const wrong = run('intake');
  await action(wrong, 'intake.submit', { ...intake, email: 'other@example.invalid', insured: false, marketing: true });
  assert.equal((await result(wrong)).checks.find((entry) => entry.id === 'intake.fields').passed, false);
});

test('inventory filters, paginates, refreshes and reserves the correct stock', async () => {
  const created = run('inventory');
  const first = await json(`/api/runs/${created.runId}/inventory?region=East&availability=Ready`);
  assert.equal(first.items.length, 8);
  assert.ok(first.totalPages > 1);
  assert.ok(first.items.every((item) => item.region === 'East' && item.availability === 'Ready'));
  const second = await json(`/api/runs/${created.runId}/inventory?region=East&availability=Ready&page=2`);
  assert.ok(second.items.some((item) => item.sku === 'DEMO-042'));
  await allocate(created);
  await expectPassed(created);
  await action(created, 'inventory.reserve', { sku: 'DEMO-002', quantity: 1, customer: 'Birch Demo Labs' });
  const verdict = await result(created);
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.checks.find((entry) => entry.id === 'inventory.other-stock-unchanged').passed, false);
});

test('concurrent reservations cannot oversell a stock row', async () => {
  const created = run('inventory');
  const available = server.getRun(created.runId).state.inventory.items.find((item) => item.sku === 'DEMO-042').available;
  const payload = { type: 'inventory.reserve', sku: 'DEMO-042', quantity: available, customer: 'Aster Demo Co' };
  const responses = await Promise.all([0, 1].map(() => fetch(`${server.baseUrl}/api/runs/${created.runId}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  await Promise.all(responses.map((response) => response.json()));
  const state = server.getRun(created.runId).state;
  assert.equal(state.inventory.reservations.length, 1);
  assert.equal(state.inventory.items.find((item) => item.sku === 'DEMO-042').available, 0);
});

test('approvals preserve cancellation and one correct finance decision', async () => {
  const created = run('approvals');
  await action(created, 'approvals.cancel', { id: 'APR-204' });
  assert.equal(server.getRun(created.runId).state.approvals.entries[0].status, 'pending');
  await action(created, 'approvals.approve', { id: 'APR-204', reason: 'FIN-DEMO-7' });
  await expectPassed(created);
  const before = server.getRun(created.runId);
  await action(created, 'approvals.approve', { id: 'APR-204', reason: 'FIN-DEMO-7' }, 409);
  assert.deepEqual(server.getRun(created.runId), before);
  await action(created, 'approvals.approve', { id: 'APR-205', reason: 'FIN-DEMO-8' });
  assert.equal((await result(created)).checks.find((entry) => entry.id === 'approvals.other-request-unchanged').passed, false);
});

test('dispatch checks attachment bytes and leaves other parcels alone', async () => {
  const created = run('board');
  await action(created, 'board.move', { cardId: 'PAR-104', lane: 'Dispatched' }, 409);
  await dispatch(created);
  await expectPassed(created);
  const attachment = server.getRun(created.runId).state.board.attachments[0];
  assert.equal(attachment.size, Buffer.byteLength(parcelNote));
  assert.match(attachment.sha256, /^[a-f0-9]{64}$/);
  const forged = run('board');
  await dispatch(forged, 'A different synthetic document with the same filename.');
  const verdict = await result(forged);
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.checks.find((entry) => entry.id === 'board.attachment-content').passed, false);
});

test('routing must persist through a subsequent component read', async () => {
  const created = run('frames');
  await json(`/api/runs/${created.runId}/routes`);
  await action(created, 'frames.save', routing);
  assert.equal((await result(created)).checks.find((entry) => entry.id === 'frames.persisted-on-reload').passed, false);
  const loaded = await json(`/api/runs/${created.runId}/routes`);
  assert.deepEqual(loaded.routes[0], routing);
  await expectPassed(created);
  await action(created, 'frames.save', { ...routing, routeId: 'ROUTE-8' });
  assert.equal((await result(created)).status, 'failed');
});

test('receiving validates the seal, one receipt and separate reconciliation', async () => {
  const created = run('tabs');
  await action(created, 'tabs.confirm', { ...receiving, seal: 'DEMO-SEAL-732' }, 409);
  assert.equal(server.getRun(created.runId).state.tabs.confirmations.length, 0);
  await action(created, 'tabs.confirm', receiving);
  assert.equal((await result(created)).status, 'failed');
  await action(created, 'tabs.reconcile', { orderId: 'PO-731' });
  await expectPassed(created);
  await action(created, 'tabs.confirm', receiving, 409);
  await action(created, 'tabs.reconcile', { orderId: 'PO-731' }, 409);
  await expectPassed(created);
});

test('diagnostics requires failed evidence, cancelled work, repair and a successful retry', async () => {
  const created = run('diagnostics', 27);
  const failure = await json(`/api/runs/${created.runId}/connector`, {}, 503);
  assert.equal(failure.code, 'DEMO_ROUTE_RETIRED');
  const fields = { errorCode: failure.code, traceId: failure.traceId, note: 'Demo connector migrated' };
  await action(created, 'diagnostics.resolve', fields, 409);
  const scan = await action(created, 'diagnostics.scan.start');
  const outstanding = fetch(`${server.baseUrl}/api/runs/${created.runId}/scan/${scan.id}`);
  await action(created, 'diagnostics.scan.cancel', { scanId: scan.id });
  await action(created, 'diagnostics.configure', { connector: 'v2' });
  const success = await json(`/api/runs/${created.runId}/connector`);
  assert.equal(success.code, 'DEMO_CONNECTOR_READY');
  await action(created, 'diagnostics.resolve', fields);
  await expectPassed(created);
  assert.equal((await (await outstanding).json()).status, 'cancelled');
  await expectPassed(created);
  await action(created, 'diagnostics.resolve', { ...fields, traceId: 'DEMO-WRONG-TRACE' });
  assert.equal((await result(created)).status, 'failed');
});

test('journey links a separate set of request, stock, parcel and receiving records in order', async () => {
  const created = run('journey');
  const independent = run('intake');
  await action(independent, 'intake.submit', intake);
  await action(created, 'journey.finish', {}, 409);
  await action(created, 'inventory.reserve', { sku: 'DEMO-042', quantity: 7, customer: 'Aster Demo Co' }, 409);
  await action(created, 'intake.submit', intake);
  await allocate(created);
  await action(created, 'tabs.confirm', receiving, 409);
  await dispatch(created);
  await receive(created);
  assert.equal((await result(created)).status, 'failed');
  await action(created, 'journey.finish');
  await expectPassed(created);
  assert.equal(server.getRun(created.runId).state.journey.orders[0].requestId, 'REQ-001');
  await action(created, 'journey.finish', {}, 409);
  assert.equal(server.getRun(independent.runId).state.journey.orders.length, 0);
});

test('external JSON inputs reject unknown fields, invalid types and unavailable records atomically', async () => {
  const created = run('intake');
  const before = server.getRun(created.runId);
  for (const fields of [
    { ...intake, units: '12' }, { ...intake, units: 0 }, { ...intake, email: 'not-an-email' },
    { ...intake, deliveryDate: '2030-02-31' }, { ...intake, terms: false }, { ...intake, extra: true },
    { ...intake, insured: 'true' },
  ]) await action(created, 'intake.submit', fields, 400);
  await action(created, 'unknown.operation', {}, 400);
  await action(created, 'toString', {}, 400);
  await action(created, 'board.move', { cardId: 'PAR-104', lane: 'Packed' }, 403);
  assert.deepEqual(server.getRun(created.runId), before);
  const board = run('board');
  await action(board, 'board.move', { cardId: 'PAR-999', lane: 'Packed' }, 404);
  await action(board, 'board.attach', { cardId: 'PAR-104', name: '../parcel-note.txt', mime: 'text/plain', content: parcelNote }, 400);
  await action(board, 'board.attach', { cardId: 'PAR-104', name: 'parcel-note.txt', mime: 'application/javascript', content: parcelNote }, 400);
  const inventory = run('inventory');
  await json(`/api/runs/${inventory.runId}/inventory?page=0`, {}, 400);
  await json(`/api/runs/${inventory.runId}/inventory?page=2&page=1`, {}, 400);
  await json(`/api/runs/${inventory.runId}/inventory?region=Unknown`, {}, 400);
  await json(`/api/runs/${inventory.runId}/inventory?query=does-not-exist&page=2`, {}, 400);
  await json(`/api/runs/${inventory.runId}/inventory?extra=1`, {}, 400);
});

test('run creation and transport validate only the exposed local input boundary', async () => {
  for (const body of [null, [], {}, { scenarioId: 'unknown' }, { scenarioId: 'intake', seed: -1 }, { scenarioId: 'intake', seed: 0.5 }, { scenarioId: 'intake', seed: 2 ** 32 }, { scenarioId: 'intake', extra: true }]) await post('/api/runs', body, 400);
  await json('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400);
  await json('/api/runs', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, 415);
  await json('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://foreign.example.invalid' }, body: '{"scenarioId":"intake"}' }, 403);
  await json('/api/runs/unknown-id', {}, 404);
  await json('/api/runs/unknown-id/result', {}, 404);
  await assert.rejects(() => startFixtureServer({ host: '0.0.0.0' }), /loopback/);
  await assert.rejects(() => startFixtureServer({ port: -1 }), /port/);
  await assert.rejects(() => startFixtureServer({ seed: '1' }), /seed/);
});

test('local frontend assets and nested frame entry pages are served without external resources', async () => {
  const created = run('frames');
  for (const path of ['/', new URL(created.url).pathname + new URL(created.url).search, `/frame?runId=${created.runId}&level=outer`, `/frame?runId=${created.runId}&level=inner`, '/assets/app.mjs', '/assets/components.mjs', '/assets/styles.css']) {
    const response = await fetch(server.baseUrl + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.text()).length > 100);
  }
  await json(`/frame?runId=${created.runId}&level=other`, {}, 400);
});

test('server close is idempotent and rejects subsequent connections', async () => {
  const isolated = await startFixtureServer();
  await isolated.close();
  await isolated.close();
  await assert.rejects(() => fetch(isolated.baseUrl));
});
