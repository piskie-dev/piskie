#!/usr/bin/env node

import WebSocket from 'ws';

const cdpBaseUrl = process.env.PISKIE_ELECTRON_CDP_URL ?? 'http://127.0.0.1:9223';
const timeoutMs = Number(process.env.PISKIE_ELECTRON_CDP_TIMEOUT_MS ?? 15_000);

function deadline(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function findRendererTarget() {
  const response = await deadline(fetch(new URL('/json/list', cdpBaseUrl)), 'CDP target lookup');
  if (!response.ok) throw new Error(`CDP target lookup returned HTTP ${response.status}`);

  const targets = await response.json();
  const target = targets.find((candidate) => (
    candidate.type === 'page'
    && typeof candidate.webSocketDebuggerUrl === 'string'
  ));
  if (!target) throw new Error('No Electron renderer target is available');
  return target;
}

async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await deadline(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket connection failed')), {
      once: true,
    });
  }), 'CDP WebSocket connection');

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(`CDP request failed: ${message.error.message ?? 'unknown error'}`));
    } else {
      request.resolve(message.result);
    }
  });

  return {
    close: () => socket.close(),
    request(method, params = {}) {
      const id = ++nextId;
      return deadline(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }), method);
    },
  };
}

const verificationExpression = String.raw`
(async () => {
  const api = window.piskie;
  const baseChecks = {
    piskieExposed: Boolean(api),
    legacyElectronApiAbsent: typeof window.electronAPI === 'undefined',
    electronHost: api?.runtime?.host === 'electron',
    protocolVersionOne: api?.runtime?.protocolVersion === 1,
    immutableApi: Boolean(api) && Object.isFrozen(api),
  };

  if (!api) return { ok: false, checks: baseChecks, observations: {} };

  const call = async (label, invoke) => {
    try {
      return { label, ok: true, value: await invoke() };
    } catch (error) {
      return {
        label,
        ok: false,
        errorName: typeof error?.name === 'string' ? error.name : typeof error,
        errorCode: typeof error?.code === 'string' ? error.code : null,
        errorMessage: typeof error?.message === 'string' ? error.message : String(error),
      };
    }
  };
  const calls = await Promise.all([
    call('runtime', () => api.runtime.status()),
    call('messaging', () => api.messaging.status()),
    call('proxy', () => api.configuration.proxy.read()),
    call('configurationDomains', () => api.configuration.listDomains()),
    call('browserEnvironmentConfig', () => api.configuration.read('browser-profiles')),
    call('mcp', () => api.capabilities.mcp.list()),
    call('taskDefinitions', () => api.taskDefinitions.list()),
    call('agentRuns', () => api.agentRuns.list()),
    call('browserEnvironments', () => api.pilot.environments.list()),
    call('browserEnvironmentGroups', () => api.pilot.environments.listGroups()),
    call('desktop', () => api.desktop.system.info()),
  ]);
  const result = Object.fromEntries(calls.map((entry) => [entry.label, entry]));
  const runtime = result.runtime.value;
  const messaging = result.messaging.value;
  const proxy = result.proxy.value;
  const configurationDomains = result.configurationDomains.value;
  const browserEnvironmentConfig = result.browserEnvironmentConfig.value;
  const mcp = result.mcp.value;
  const taskDefinitions = result.taskDefinitions.value;
  const agentRuns = result.agentRuns.value;
  const browserEnvironments = result.browserEnvironments.value;
  const browserEnvironmentGroups = result.browserEnvironmentGroups.value;
  const desktop = result.desktop.value;

  const messagingConfigs = Array.isArray(messaging?.configs) ? messaging.configs : [];
  const messagingStates = Array.isArray(messaging?.botStates) ? messaging.botStates : [];
  const proxyProfiles = Array.isArray(proxy?.proxies) ? proxy.proxies : [];
  const mcpServers = Array.isArray(mcp) ? mcp : [];
  const taskDefinitionItems = Array.isArray(taskDefinitions) ? taskDefinitions : [];
  const agentRunItems = Array.isArray(agentRuns) ? agentRuns : [];
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const browserDomain = Array.isArray(configurationDomains)
    ? configurationDomains.find((domain) => domain?.id === 'browser-profiles')
    : undefined;
  const configuredEnvironments = isRecord(browserEnvironmentConfig?.environments)
    ? browserEnvironmentConfig.environments
    : undefined;
  const configuredEnvironmentGroups = isRecord(browserEnvironmentConfig?.groups)
    ? browserEnvironmentConfig.groups
    : undefined;
  const checks = {
    ...baseChecks,
    runtimeReady: runtime?.phase === 'ready',
    runtimeNotDegraded: Array.isArray(runtime?.degraded) && runtime.degraded.length === 0,
    messagingCallable: result.messaging.ok
      && Array.isArray(messaging?.configs)
      && Array.isArray(messaging?.botStates),
    proxyCallable: result.proxy.ok && Array.isArray(proxy?.proxies),
    browserDomainActive: result.configurationDomains.ok
      && browserDomain?.availability?.state === 'active'
      && browserDomain.availability.configurable === true
      && browserDomain.availability.runtimeActive === true,
    browserEnvironmentConfigCallable: result.browserEnvironmentConfig.ok
      && Number.isSafeInteger(browserEnvironmentConfig?.revision)
      && Boolean(configuredEnvironments)
      && Boolean(configuredEnvironmentGroups),
    browserEnvironmentsCallable: result.browserEnvironments.ok && Array.isArray(browserEnvironments),
    browserEnvironmentGroupsCallable: result.browserEnvironmentGroups.ok
      && Array.isArray(browserEnvironmentGroups),
    browserEnvironmentProjectionConsistent: Boolean(configuredEnvironments)
      && Boolean(configuredEnvironmentGroups)
      && Array.isArray(browserEnvironments)
      && Array.isArray(browserEnvironmentGroups)
      && Object.keys(configuredEnvironments).length === browserEnvironments.length
      && Object.keys(configuredEnvironmentGroups).length === browserEnvironmentGroups.length,
    mcpCallable: result.mcp.ok && Array.isArray(mcp),
    taskDefinitionsCallable: result.taskDefinitions.ok && Array.isArray(taskDefinitions),
    agentRunsCallable: result.agentRuns.ok && Array.isArray(agentRuns),
    desktopCallable: result.desktop.ok
      && typeof desktop?.name === 'string'
      && typeof desktop?.version === 'string',
    messagingCredentialsCanonical: [...messagingConfigs, ...messagingStates.map((state) => state?.config)]
      .filter(Boolean)
      .every((config) => (
        !Object.hasOwn(config, 'hasAppSecret')
        && (!Object.hasOwn(config, 'appSecret') || typeof config.appSecret === 'string')
      )),
    proxyCredentialsCanonical: proxyProfiles.every((profile) => (
      !Object.hasOwn(profile, 'hasPassword')
      && (!Object.hasOwn(profile, 'password') || typeof profile.password === 'string')
    )),
    mcpCredentialsCanonical: mcpServers.every((server) => (
      !server?.config
      || (
        (!Object.hasOwn(server.config, 'env') || isRecord(server.config.env))
        && (!Object.hasOwn(server.config, 'http_headers') || isRecord(server.config.http_headers))
      )
    )),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    observations: {
      runtimePhase: runtime?.phase ?? null,
      degradedCount: Array.isArray(runtime?.degraded) ? runtime.degraded.length : null,
      messagingConfigCount: messagingConfigs.length,
      messagingStateCount: messagingStates.length,
      proxyCount: proxyProfiles.length,
      browserDomainState: browserDomain?.availability?.state ?? null,
      browserEnvironmentCount: Array.isArray(browserEnvironments) ? browserEnvironments.length : null,
      browserEnvironmentGroupCount: Array.isArray(browserEnvironmentGroups)
        ? browserEnvironmentGroups.length
        : null,
      mcpCount: mcpServers.length,
      taskDefinitionCount: taskDefinitionItems.length,
      agentRunCount: agentRunItems.length,
      desktopInfoFields: Object.keys(desktop ?? {}).sort(),
      apiNamespaces: Object.keys(api).sort(),
      failedCalls: calls
        .filter((entry) => !entry.ok)
        .map(({ label, errorName, errorCode, errorMessage }) => ({
          label,
          errorName,
          errorCode,
          errorMessage,
        })),
    },
  };
})()
`;

let client;
try {
  const target = await findRendererTarget();
  client = await connect(target.webSocketDebuggerUrl);
  await client.request('Runtime.enable');
  const evaluated = await client.request('Runtime.evaluate', {
    expression: verificationExpression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails || !evaluated.result?.value) {
    throw new Error('Electron renderer verification expression failed');
  }

  const report = evaluated.result.value;
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Electron host live verification failed');
  process.exitCode = 1;
} finally {
  client?.close();
}
