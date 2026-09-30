import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 4010;
const DEFAULT_MODEL = 'mock-model';
const DEFAULT_RESPONSE_TEXT = 'Mock retry succeeded.';

export const OPENAI_RESPONSES_FAULT_SCENARIOS = Object.freeze([
  'sse-overload',
  'sse-stream-error',
  'empty-response',
  'http-503',
  'disconnect-before-output',
]);

/**
 * Starts a loopback-only OpenAI Responses fixture for retry and reconnect tests.
 * The first `failuresBeforeSuccess` Responses calls fail; later calls complete.
 */
export async function startOpenAiResponsesFaultServer(options = {}) {
  const config = normalizeOptions(options);
  let responseAttempts = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      config.logger.error(`[mock-ai] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, {
        error: { code: 'mock_server_error', message: 'OpenAI fault fixture failed to handle the request.' },
      });
    });
  });

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: config.model, object: 'model', created: 0, owned_by: 'piskie-test' }],
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/__control/state') {
      sendJson(response, 200, currentState());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/__control/reset') {
      let state;
      try {
        state = reset(await readResetOptions(request));
      } catch (error) {
        sendJson(response, 400, {
          error: {
            code: 'invalid_reset',
            message: error instanceof SyntaxError ? 'Reset body must be valid JSON.' : error.message,
          },
        });
        return;
      }
      config.logger.info(
        `[mock-ai] counter reset scenario=${state.scenario} failures=${state.failuresBeforeSuccess}`,
      );
      sendJson(response, 200, state);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      const { scenario, failuresBeforeSuccess } = config;
      const attempt = ++responseAttempts;
      const shouldFail = attempt <= failuresBeforeSuccess;
      if (shouldFail && scenario === 'disconnect-before-output') {
        config.logger.info(`[mock-ai] responses attempt=${attempt} outcome=disconnect-before-output`);
        request.socket.destroy();
        return;
      }

      await discardBody(request);
      if (shouldFail) {
        config.logger.info(`[mock-ai] responses attempt=${attempt} outcome=${scenario}`);
        if (scenario === 'sse-overload') sendStatuslessSseOverload(response, attempt);
        else if (scenario === 'sse-stream-error') sendStatuslessSseStreamError(response, attempt);
        else if (scenario === 'empty-response') {
          sendCompletedResponse(response, { attempt, model: config.model, text: '' });
        } else sendHttpOverload(response, attempt);
        return;
      }

      config.logger.info(`[mock-ai] responses attempt=${attempt} outcome=success`);
      sendCompletedResponse(response, {
        attempt,
        model: config.model,
        text: config.responseText,
      });
      return;
    }

    await discardBody(request);
    sendJson(response, 404, {
      error: { code: 'not_found', message: `No mock route for ${request.method ?? 'UNKNOWN'} ${url.pathname}` },
    });
  }

  function reset(options = {}) {
    const next = normalizeResetOptions(options, config);
    config.scenario = next.scenario;
    config.failuresBeforeSuccess = next.failuresBeforeSuccess;
    responseAttempts = 0;
    return currentState();
  }

  function currentState() {
    const remainingFailures = Math.max(0, config.failuresBeforeSuccess - responseAttempts);
    return {
      scenario: config.scenario,
      failuresBeforeSuccess: config.failuresBeforeSuccess,
      responseAttempts,
      remainingFailures,
      nextOutcome: remainingFailures > 0 ? config.scenario : 'success',
      model: config.model,
    };
  }

  await listen(server, config.port);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OpenAI fault fixture did not bind to TCP');
  const origin = `http://${LOOPBACK_HOST}:${address.port}`;

  return {
    origin,
    baseUrl: `${origin}/v1`,
    port: address.port,
    model: config.model,
    get scenario() { return config.scenario; },
    state: currentState,
    reset,
    async close() {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

function normalizeOptions(options) {
  return {
    scenario: scenarioOption(options.scenario ?? 'sse-overload'),
    port: integerOption(options.port ?? DEFAULT_PORT, 'port', 0, 65_535),
    failuresBeforeSuccess: integerOption(
      options.failuresBeforeSuccess ?? 1,
      'failuresBeforeSuccess',
      0,
      100,
    ),
    model: nonEmptyString(options.model ?? DEFAULT_MODEL, 'model'),
    responseText: nonEmptyString(options.responseText ?? DEFAULT_RESPONSE_TEXT, 'responseText'),
    logger: options.logger ?? console,
  };
}

function normalizeResetOptions(options, config) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Reset body must be a JSON object.');
  }
  if (Object.keys(options).some((key) => key !== 'scenario' && key !== 'failuresBeforeSuccess')) {
    throw new Error('Reset accepts only scenario and failuresBeforeSuccess.');
  }
  const scenario = Object.hasOwn(options, 'scenario')
    ? scenarioOption(options.scenario)
    : config.scenario;
  const failuresBeforeSuccess = Object.hasOwn(options, 'failuresBeforeSuccess')
    ? options.failuresBeforeSuccess
    : config.failuresBeforeSuccess;
  if (typeof failuresBeforeSuccess !== 'number') {
    throw new Error('failuresBeforeSuccess must be an integer from 0 to 100.');
  }
  return {
    scenario,
    failuresBeforeSuccess: integerOption(failuresBeforeSuccess, 'failuresBeforeSuccess', 0, 100),
  };
}

function scenarioOption(value) {
  if (!OPENAI_RESPONSES_FAULT_SCENARIOS.includes(value)) {
    throw new Error(`scenario must be one of: ${OPENAI_RESPONSES_FAULT_SCENARIOS.join(', ')}`);
  }
  return value;
}

function integerOption(value, name, minimum, maximum) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

async function listen(server, port) {
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once('error', onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

async function readResetOptions(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8').trim();
  return body.length > 0 ? JSON.parse(body) : {};
}

async function discardBody(request) {
  for await (const chunk of request) {
    // Drain without retaining prompts or credentials in this test fixture.
    void chunk;
  }
}

function sendStatuslessSseOverload(response, attempt) {
  beginSse(response, { 'x-request-id': `mock-overload-${attempt}` });
  response.end(`data: ${JSON.stringify({
    error: {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.',
      param: null,
    },
  })}\n\n`);
}

function sendStatuslessSseStreamError(response, attempt) {
  beginSse(response, { 'x-request-id': `mock-stream-error-${attempt}` });
  writeSseData(response, {
    type: 'response.output_text.delta',
    item_id: 'message',
    output_index: 0,
    content_index: 0,
    sequence_number: 1,
    delta: 'Mock partial text (discard this attempt).',
    logprobs: [],
  });
  writeSseData(response, {
    error: {
      type: 'upstream_error',
      code: 'upstream_stream_read_error',
      message: 'Mock upstream stream interrupted after partial output.',
    },
  });
  response.end();
}

function sendHttpOverload(response, attempt) {
  sendJson(response, 503, {
    error: {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.',
      param: null,
    },
  }, { 'x-request-id': `mock-overload-${attempt}` });
}

function sendCompletedResponse(response, input) {
  const hasText = input.text.length > 0;
  beginSse(response, { 'x-request-id': `mock-${hasText ? 'success' : 'empty'}-${input.attempt}` });
  if (hasText) {
    writeSseData(response, {
      type: 'response.output_text.delta',
      item_id: 'message',
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: input.text,
      logprobs: [],
    });
  }
  writeSseData(response, {
    type: 'response.completed',
    sequence_number: hasText ? 2 : 1,
    response: {
      id: `response-mock-${input.attempt}`,
      object: 'response',
      status: 'completed',
      model: input.model,
      output: [],
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        output_tokens: hasText ? 1 : 0,
        total_tokens: hasText ? 2 : 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  response.end('data: [DONE]\n\n');
}

function beginSse(response, headers = {}) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
    ...headers,
  });
}

function writeSseData(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(`${JSON.stringify(value)}\n`);
}

function printHelp() {
  console.log(`Usage: node scripts/testing/openai-responses-fault-server.mjs [options]

Options:
  --port <number>       Loopback port (default: ${DEFAULT_PORT})
  --scenario <name>     ${OPENAI_RESPONSES_FAULT_SCENARIOS.join(' | ')}
  --failures <number>   Failed Responses calls before success (default: 1)
  --model <id>          Model returned by /v1/models (default: ${DEFAULT_MODEL})
  --response-text <text> Successful response text
  --help                Show this help
`);
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: String(DEFAULT_PORT) },
      scenario: { type: 'string', default: 'sse-overload' },
      failures: { type: 'string', default: '1' },
      model: { type: 'string', default: DEFAULT_MODEL },
      'response-text': { type: 'string', default: DEFAULT_RESPONSE_TEXT },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }

  const fixture = await startOpenAiResponsesFaultServer({
    port: integerOption(values.port, 'port', 1, 65_535),
    scenario: values.scenario,
    failuresBeforeSuccess: integerOption(values.failures, 'failures', 0, 100),
    model: values.model,
    responseText: values['response-text'],
  });
  console.log(`[mock-ai] base URL: ${fixture.baseUrl}`);
  console.log(`[mock-ai] model: ${fixture.model}`);
  console.log(`[mock-ai] scenario: ${fixture.scenario}`);
  console.log(`[mock-ai] reset: POST ${fixture.origin}/__control/reset (optional JSON: scenario, failuresBeforeSuccess)`);
  console.log(`[mock-ai] state: GET ${fixture.origin}/__control/state`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[mock-ai] ${signal}; stopping`);
    await fixture.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(`[mock-ai] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
