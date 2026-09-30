import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';

import { startOpenAiResponsesFaultServer } from './openai-responses-fault-server.mjs';

const quietLogger = { info() {}, error() {} };

test('returns one statusless SSE overload, then a successful Responses stream', async (context) => {
  const fixture = await startOpenAiResponsesFaultServer({
    port: 0,
    scenario: 'sse-overload',
    failuresBeforeSuccess: 1,
    logger: quietLogger,
  });
  context.after(() => fixture.close());

  const models = await fetch(`${fixture.baseUrl}/models`).then((response) => response.json());
  assert.equal(models.data[0].id, 'mock-model');

  const first = await callResponses(fixture.baseUrl);
  assert.equal(first.status, 200);
  assert.match(first.body, /"code":"server_is_overloaded"/);
  assert.doesNotMatch(first.body, /response\.completed/);

  const second = await callResponses(fixture.baseUrl);
  assert.equal(second.status, 200);
  assert.match(second.body, /Mock retry succeeded\./);
  assert.match(second.body, /response\.completed/);

  const state = await fetch(`${fixture.origin}/__control/state`).then((response) => response.json());
  assert.deepEqual(state, {
    scenario: 'sse-overload',
    failuresBeforeSuccess: 1,
    responseAttempts: 2,
    remainingFailures: 0,
    nextOutcome: 'success',
    model: 'mock-model',
  });

  const reset = await fetch(`${fixture.origin}/__control/reset`, { method: 'POST' })
    .then((response) => response.json());
  assert.equal(reset.responseAttempts, 0);
  assert.match((await callResponses(fixture.baseUrl)).body, /"code":"server_is_overloaded"/);
});

test('supports ordinary HTTP 503 overload responses', async (context) => {
  const fixture = await startOpenAiResponsesFaultServer({
    port: 0,
    scenario: 'http-503',
    failuresBeforeSuccess: 1,
    logger: quietLogger,
  });
  context.after(() => fixture.close());

  const first = await callResponses(fixture.baseUrl);
  assert.equal(first.status, 503);
  assert.match(first.body, /"code":"server_is_overloaded"/);
  assert.match((await callResponses(fixture.baseUrl)).body, /response\.completed/);
});

test('matches the statusless error and recovery shape consumed by the OpenAI SDK', async (context) => {
  const fixture = await startOpenAiResponsesFaultServer({
    port: 0,
    scenario: 'sse-overload',
    failuresBeforeSuccess: 1,
    logger: quietLogger,
  });
  context.after(() => fixture.close());
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: fixture.baseUrl,
    maxRetries: 0,
  });

  const failedStream = await client.responses.create({
    model: fixture.model,
    input: 'hello',
    stream: true,
  });
  await assert.rejects(async () => {
    for await (const event of failedStream) {
      assert.fail(`The overload envelope unexpectedly emitted ${event.type}`);
    }
  }, (error) => {
    assert.equal(error.code, 'server_is_overloaded');
    assert.equal(error.type, 'service_unavailable_error');
    assert.equal(error.status, undefined);
    return true;
  });

  const recoveredStream = await client.responses.create({
    model: fixture.model,
    input: 'hello',
    stream: true,
  });
  const events = [];
  for await (const event of recoveredStream) events.push(event);

  assert.deepEqual(events.map((event) => event.type), [
    'response.output_text.delta',
    'response.completed',
  ]);
  assert.equal(events[0].delta, 'Mock retry succeeded.');
});

test('supports a transport disconnect before visible output', async (context) => {
  const fixture = await startOpenAiResponsesFaultServer({
    port: 0,
    scenario: 'disconnect-before-output',
    failuresBeforeSuccess: 1,
    logger: quietLogger,
  });
  context.after(() => fixture.close());

  await assert.rejects(callResponses(fixture.baseUrl), /fetch failed|socket|terminated/i);
  assert.match((await callResponses(fixture.baseUrl)).body, /response\.completed/);
});

for (const scenario of ['sse-stream-error', 'empty-response']) {
  for (const failuresBeforeSuccess of [1, 3]) {
    test(`${scenario} fails ${failuresBeforeSuccess} times before SDK recovery and repeats after reset`, async (context) => {
      const fixture = await startOpenAiResponsesFaultServer({
        port: 0,
        scenario,
        failuresBeforeSuccess,
        logger: quietLogger,
      });
      context.after(() => fixture.close());
      const client = sdkClient(fixture);

      for (let cycle = 0; cycle < 2; cycle++) {
        const initial = await fetch(`${fixture.origin}/__control/state`)
          .then((response) => response.json());
        await client.models.list();
        assert.equal(initial.responseAttempts, 0);
        assert.equal(fixture.state().responseAttempts, 0);
        assert.equal(initial.nextOutcome, scenario);

        for (let attempt = 1; attempt <= failuresBeforeSuccess; attempt++) {
          await assertFaultStream(client, fixture, scenario);
          assert.equal(fixture.state().responseAttempts, attempt);
          assert.equal(fixture.state().remainingFailures, failuresBeforeSuccess - attempt);
        }
        await assertSuccessfulStream(client, fixture);
        assert.equal(fixture.state().responseAttempts, failuresBeforeSuccess + 1);
        assert.equal(fixture.state().nextOutcome, 'success');

        if (cycle === 0) {
          const reset = await fetch(`${fixture.origin}/__control/reset`, { method: 'POST' });
          assert.equal(reset.status, 200);
          assert.deepEqual(await reset.json(), initial);
        }
      }
    });
  }
}

test('reset switches scenarios and failure counts without restarting the server', async (context) => {
  const fixture = await startOpenAiResponsesFaultServer({ port: 0, logger: quietLogger });
  context.after(() => fixture.close());
  const client = sdkClient(fixture);
  await callResponses(fixture.baseUrl);
  assert.equal(fixture.state().responseAttempts, 1);

  const reset = await resetWithJson(fixture, { scenario: 'sse-stream-error', failuresBeforeSuccess: 3 });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), {
    scenario: 'sse-stream-error',
    failuresBeforeSuccess: 3,
    responseAttempts: 0,
    remainingFailures: 3,
    nextOutcome: 'sse-stream-error',
    model: 'mock-model',
  });
  assert.equal(fixture.scenario, 'sse-stream-error');
  await assertFaultStream(client, fixture, 'sse-stream-error');

  const switched = await resetWithJson(fixture, { scenario: 'empty-response' });
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).failuresBeforeSuccess, 3);
  for (let attempt = 0; attempt < 3; attempt++) {
    await assertFaultStream(client, fixture, 'empty-response');
  }
  await assertSuccessfulStream(client, fixture);

  const successOnly = await resetWithJson(fixture, { failuresBeforeSuccess: 0 });
  assert.equal(successOnly.status, 200);
  assert.equal((await successOnly.json()).scenario, 'empty-response');
  await assertSuccessfulStream(client, fixture);
  assert.equal(fixture.state().responseAttempts, 1);

  fixture.reset({ scenario: 'sse-stream-error', failuresBeforeSuccess: 1 });
  await assertFaultStream(client, fixture, 'sse-stream-error');
  await assertSuccessfulStream(client, fixture);
});

test('invalid reset input leaves the scenario and attempt counter unchanged', async (context) => {
  const fixture = await startOpenAiResponsesFaultServer({
    port: 0,
    scenario: 'empty-response',
    failuresBeforeSuccess: 3,
    logger: quietLogger,
  });
  context.after(() => fixture.close());
  await callResponses(fixture.baseUrl);
  const before = fixture.state();

  const invalidBodies = [
    '{', 'null', '[]', 'false',
    JSON.stringify({ scenario: 'unknown-scenario' }),
    JSON.stringify({ scenario: null }),
    JSON.stringify({ model: 'another-model' }),
    ...[-1, 101, 1.5, '3', '3junk', null].map((failuresBeforeSuccess) =>
      JSON.stringify({ scenario: 'sse-stream-error', failuresBeforeSuccess })),
  ];
  for (const body of invalidBodies) {
    const response = await fetch(`${fixture.origin}/__control/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).error.code, 'invalid_reset');
    assert.deepEqual(fixture.state(), before);
  }
});

function sdkClient(fixture) {
  return new OpenAI({ apiKey: 'test-key', baseURL: fixture.baseUrl, maxRetries: 0 });
}

async function collectSdkEvents(client, fixture, events = []) {
  const stream = await client.responses.create({
    model: fixture.model,
    input: 'Sample task',
    stream: true,
  });
  for await (const event of stream) events.push(event);
  return events;
}

async function assertFaultStream(client, fixture, scenario) {
  const events = [];
  if (scenario === 'sse-stream-error') {
    await assert.rejects(collectSdkEvents(client, fixture, events), (error) => {
      assert.equal(error.code, 'upstream_stream_read_error');
      assert.equal(error.type, 'upstream_error');
      assert.equal(error.status, undefined);
      return true;
    });
    assert.deepEqual(events.map((event) => event.type), ['response.output_text.delta']);
    assert.equal(events[0].delta, 'Mock partial text (discard this attempt).');
  } else {
    await collectSdkEvents(client, fixture, events);
    assert.deepEqual(events.map((event) => event.type), ['response.completed']);
    assert.equal(events[0].response.status, 'completed');
    assert.deepEqual(events[0].response.output, []);
    assert.equal(events[0].response.incomplete_details, null);
    assert.equal(events[0].response.usage.output_tokens, 0);
    assert.equal(events[0].response.usage.output_tokens_details.reasoning_tokens, 0);
  }
}

async function assertSuccessfulStream(client, fixture) {
  const events = await collectSdkEvents(client, fixture);
  assert.deepEqual(events.map((event) => event.type), [
    'response.output_text.delta',
    'response.completed',
  ]);
  assert.equal(events[0].delta, 'Mock retry succeeded.');
  assert.equal(events[1].response.status, 'completed');
}

function resetWithJson(fixture, options) {
  return fetch(`${fixture.origin}/__control/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
}

async function callResponses(baseUrl) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', input: 'hello', stream: true }),
  });
  return { status: response.status, body: await response.text() };
}
