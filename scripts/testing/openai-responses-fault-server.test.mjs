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

async function callResponses(baseUrl) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', input: 'hello', stream: true }),
  });
  return { status: response.status, body: await response.text() };
}
