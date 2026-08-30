import {
  AGENT_RUN_OPERATIONS,
  AGENT_OPERATIONS,
  AGENT_TOPICS,
  CAPABILITY_OPERATIONS,
  CAPABILITY_TOPICS,
  CONFIGURATION_OPERATIONS,
  CONFIGURATION_TOPICS,
  DESKTOP_OPERATIONS,
  DESKTOP_TOPICS,
  INFERENCE_OPERATIONS,
  MESSAGING_OPERATIONS,
  MESSAGING_TOPICS,
  MODE_OPERATIONS,
  OBSERVABILITY_OPERATIONS,
  OBSERVABILITY_TOPICS,
  PILOT_OPERATIONS,
  PILOT_TOPICS,
  RUNTIME_OPERATIONS,
  TASK_DEFINITION_OPERATIONS,
  type PiskieDesktopApi,
} from '../../../shared/electron-contracts/index.js';
import type { ElectronPreloadClient } from './preload-client.js';

export function createElectronPiskieClient(options: {
  transport: ElectronPreloadClient;
  version: string;
  platform: string;
}): PiskieDesktopApi {
  const { transport } = options;
  const request = <T>(operation: string, ...args: unknown[]): Promise<T> => (
    transport.request<T>(operation, args)
  );
  const waitForUser = <T>(operation: string, ...args: unknown[]): Promise<T> => (
    transport.request<T>(operation, args, { timeoutMs: 0 })
  );
  const observe = <T>(topic: string, listener: (event: T) => void): (() => void) => (
    transport.subscribe<unknown, T>(topic, {
      onChange: listener,
    })
  );

  const api: PiskieDesktopApi = {
    runtime: {
      host: 'electron',
      protocolVersion: 1,
      version: options.version,
      status: () => request(RUNTIME_OPERATIONS.status),
    },
    agents: {
      start: (input) => request(AGENT_OPERATIONS.start, input),
      setMode: (agentId, modeId) => request(AGENT_OPERATIONS.setMode, agentId, modeId),
      listStates: () => request(AGENT_OPERATIONS.listStates),
      stop: (agentId) => request(AGENT_OPERATIONS.stop, agentId),
      resume: (agentId) => request(AGENT_OPERATIONS.resume, agentId),
      inject: (agentId, event) => request(AGENT_OPERATIONS.inject, agentId, event),
      injectSubagent: (agentId, subagentId, event) => (
        request(AGENT_OPERATIONS.injectSubagent, agentId, subagentId, event)
      ),
      setModel: (agentId, model) => request(AGENT_OPERATIONS.setModel, agentId, model),
      setSubagentModel: (agentId, subagentId, model) => (
        request(AGENT_OPERATIONS.setSubagentModel, agentId, subagentId, model)
      ),
      setReasoning: (agentId, selection) => (
        request(AGENT_OPERATIONS.setReasoning, agentId, selection)
      ),
      setSubagentReasoning: (agentId, subagentId, selection) => (
        request(AGENT_OPERATIONS.setSubagentReasoning, agentId, subagentId, selection)
      ),
      interrupt: (agentId) => request(AGENT_OPERATIONS.interrupt, agentId),
      interruptSubagent: (agentId, subagentId) => (
        request(AGENT_OPERATIONS.interruptSubagent, agentId, subagentId)
      ),
      conversation: (agentId, page) => (
        request(AGENT_OPERATIONS.conversation, agentId, page)
      ),
      context: (agentId) => request(AGENT_OPERATIONS.context, agentId),
      observeState: (listener) => observe(AGENT_TOPICS.state, listener),
      observeConversation: (listener) => observe(AGENT_TOPICS.conversation, listener),
      observeLiveContent: (listener) => observe(AGENT_TOPICS.liveContent, listener),
      approval: {
        setMode: (agentId, mode) => request(AGENT_OPERATIONS.setApprovalMode, agentId, mode),
        setSubagentMode: (agentId, subagentId, mode) => (
          request(AGENT_OPERATIONS.setSubagentApprovalMode, agentId, subagentId, mode)
        ),
        respond: (agentId, subagentId, decision) => (
          request(AGENT_OPERATIONS.respondToApproval, agentId, subagentId, decision)
        ),
      },
      images: {
        approve: (agentId, nodeId) => request(AGENT_OPERATIONS.approveImages, agentId, nodeId),
        enterEdit: (agentId, nodeId) => (
          request(AGENT_OPERATIONS.enterImageEdit, agentId, nodeId)
        ),
        regenerate: (input) => request(AGENT_OPERATIONS.regenerateImages, input),
        cancel: (agentId, nodeId, reason) => (
          request(AGENT_OPERATIONS.cancelImages, agentId, nodeId, reason)
        ),
        delete: (agentId, nodeId, imageId) => (
          request(AGENT_OPERATIONS.deleteImage, agentId, nodeId, imageId)
        ),
        changeModel: (agentId, nodeId, target) => (
          request(AGENT_OPERATIONS.changeImageModel, agentId, nodeId, target)
        ),
      },
      tools: {
        promoteToBackground: (callId) => (
          request(AGENT_OPERATIONS.promoteToolToBackground, callId)
        ),
      },
    },
    modes: {
      listAvailable: (query) => request(MODE_OPERATIONS.listAvailable, query),
    },
    taskDefinitions: {
      list: () => request(TASK_DEFINITION_OPERATIONS.list),
      create: (input) => request(TASK_DEFINITION_OPERATIONS.create, input),
      update: (definitionId, updates) => request(
        TASK_DEFINITION_OPERATIONS.update,
        definitionId,
        updates,
      ),
      delete: (definitionId) => request(TASK_DEFINITION_OPERATIONS.delete, definitionId),
    },
    agentRuns: {
      list: () => request(AGENT_RUN_OPERATIONS.list),
      state: (agentId) => request(AGENT_RUN_OPERATIONS.state, agentId),
      delete: (agentId) => request(AGENT_RUN_OPERATIONS.delete, agentId),
      readPlan: (agentId) => request(AGENT_RUN_OPERATIONS.readPlan, agentId),
      listCompactions: (agentId) => request(AGENT_RUN_OPERATIONS.listCompactions, agentId),
      originalCompactionMessages: (input) => request(
        AGENT_RUN_OPERATIONS.originalCompactionMessages,
        input,
      ),
    },
    configuration: {
      listDomains: () => request(CONFIGURATION_OPERATIONS.listDomains),
      describe: (domain) => request(CONFIGURATION_OPERATIONS.describe, domain),
      read: (domain) => request(CONFIGURATION_OPERATIONS.read, domain),
      history: (domain) => request(CONFIGURATION_OPERATIONS.history, domain),
      plan: (domain, input) => request(CONFIGURATION_OPERATIONS.plan, domain, input),
      validate: (planId) => request(CONFIGURATION_OPERATIONS.validate, planId),
      probe: (planId, input) => request(CONFIGURATION_OPERATIONS.probe, planId, input),
      apply: (planId, revision) => request(CONFIGURATION_OPERATIONS.apply, planId, revision),
      verify: (domain, revision) => request(CONFIGURATION_OPERATIONS.verify, domain, revision),
      rollback: (domain, revision) => request(CONFIGURATION_OPERATIONS.rollback, domain, revision),
      observeChanges: (listener) => observe(CONFIGURATION_TOPICS.changes, listener),
      settings: {
        read: () => request(CONFIGURATION_OPERATIONS.readSettings),
        readOne: (key) => request(CONFIGURATION_OPERATIONS.readSetting, key),
        write: (key, value) => request(CONFIGURATION_OPERATIONS.writeSetting, key, value),
        writeAll: (settings) => request(CONFIGURATION_OPERATIONS.writeSettings, settings),
        reset: () => request(CONFIGURATION_OPERATIONS.resetSettings),
        developmentFeatures: () => request(CONFIGURATION_OPERATIONS.developmentFeatures),
      },
      proxy: {
        read: () => request(CONFIGURATION_OPERATIONS.readProxy),
        add: (proxy) => request(CONFIGURATION_OPERATIONS.addProxy, proxy),
        update: (id, updates) => request(CONFIGURATION_OPERATIONS.updateProxy, id, updates),
        remove: (id) => request(CONFIGURATION_OPERATIONS.removeProxy, id),
        test: (id) => request(CONFIGURATION_OPERATIONS.testProxy, id),
      },
    },
    inference: {
      listDrivers: () => request(INFERENCE_OPERATIONS.listDrivers),
      driverSchema: (driverId) => request(INFERENCE_OPERATIONS.driverSchema, driverId),
      queryModels: (input) => request(INFERENCE_OPERATIONS.queryModels, input),
      importWorkflow: (source) => request(INFERENCE_OPERATIONS.importWorkflow, source),
      inspectWorkflow: (assetId) => request(INFERENCE_OPERATIONS.inspectWorkflow, assetId),
      detectBindings: (assetId) => request(INFERENCE_OPERATIONS.detectBindings, assetId),
      validateBindings: (input) => request(INFERENCE_OPERATIONS.validateBindings, input),
      probe: (input) => request(INFERENCE_OPERATIONS.probe, input),
      artifact: (artifactId) => request(INFERENCE_OPERATIONS.artifact, artifactId),
    },
    capabilities: {
      mcp: {
        list: (input) => request(CAPABILITY_OPERATIONS.listMcp, input),
        get: (name, input) => request(CAPABILITY_OPERATIONS.getMcp, name, input),
        search: (query) => request(CAPABILITY_OPERATIONS.searchMcp, query),
        add: (input) => request(CAPABILITY_OPERATIONS.addMcp, input),
        remove: (name, input) => request(CAPABILITY_OPERATIONS.removeMcp, name, input),
        probe: (name, input) => request(CAPABILITY_OPERATIONS.probeMcp, name, input),
        budget: (input) => request(CAPABILITY_OPERATIONS.mcpBudget, input),
        trust: (name, workspace) => request(CAPABILITY_OPERATIONS.trustMcp, name, workspace),
        login: (name, input) => request(CAPABILITY_OPERATIONS.loginMcp, name, input),
        logout: (name, input) => request(CAPABILITY_OPERATIONS.logoutMcp, name, input),
        auth: (name, input) => request(CAPABILITY_OPERATIONS.mcpAuth, name, input),
        prewarm: (input) => request(CAPABILITY_OPERATIONS.prewarmMcp, input),
        prewarmStatus: (token) => request(CAPABILITY_OPERATIONS.mcpPrewarmStatus, token),
        releasePrewarm: (token) => request(CAPABILITY_OPERATIONS.releaseMcpPrewarm, token),
        retry: (input) => request(CAPABILITY_OPERATIONS.retryMcp, input),
        sessions: (input) => request(CAPABILITY_OPERATIONS.mcpSessions, input),
      },
      market: {
        list: (query) => request(CAPABILITY_OPERATIONS.listMarket, query),
        installed: (query) => request(CAPABILITY_OPERATIONS.installedMarket, query),
        refresh: (sourceIds) => request(CAPABILITY_OPERATIONS.refreshMarket, sourceIds),
        detail: (entryId) => request(CAPABILITY_OPERATIONS.marketDetail, entryId),
        install: (input) => request(CAPABILITY_OPERATIONS.installMarket, input),
        manage: (input) => request(CAPABILITY_OPERATIONS.manageMarket, input),
        sources: () => request(CAPABILITY_OPERATIONS.marketSources),
        addSource: (input) => request(CAPABILITY_OPERATIONS.addMarketSource, input),
        removeSource: (sourceId) => request(CAPABILITY_OPERATIONS.removeMarketSource, sourceId),
        projects: () => request(CAPABILITY_OPERATIONS.marketProjects),
        preview: (workspace) => request(CAPABILITY_OPERATIONS.previewMarket, workspace),
        observeChanges: (listener) => observe(CAPABILITY_TOPICS.marketChanges, listener),
      },
    },
    pilot: {
      environments: {
        list: () => request(PILOT_OPERATIONS.listEnvironments),
        get: (environmentId) => request(PILOT_OPERATIONS.getEnvironment, environmentId),
        create: (input) => request(PILOT_OPERATIONS.createEnvironment, input),
        update: (id, updates) => request(PILOT_OPERATIONS.updateEnvironment, id, updates),
        delete: (environmentId) => request(PILOT_OPERATIONS.deleteEnvironment, environmentId),
        listGroups: () => request(PILOT_OPERATIONS.listEnvironmentGroups),
        createGroup: (name) => request(PILOT_OPERATIONS.createEnvironmentGroup, name),
        deleteGroup: (groupId) => request(PILOT_OPERATIONS.deleteEnvironmentGroup, groupId),
        start: (environmentId) => request(PILOT_OPERATIONS.startEnvironment, environmentId),
        stop: (environmentId) => request(PILOT_OPERATIONS.stopEnvironment, environmentId),
        showWindow: (environmentId) => request(PILOT_OPERATIONS.showEnvironmentWindow, environmentId),
        captureLoginTrail: (environmentId) => (
          request(PILOT_OPERATIONS.captureEnvironmentLoginTrail, environmentId)
        ),
        kernelStatus: () => request(PILOT_OPERATIONS.kernelStatus),
        installKernel: () => request(PILOT_OPERATIONS.installKernel),
        observeKernel: (listener) => observe(PILOT_TOPICS.kernel, listener),
      },
      screen: {
        snapshot: (browserId, quality) => (
          request(PILOT_OPERATIONS.screenSnapshot, browserId, quality)
        ),
        show: (browserId) => request(PILOT_OPERATIONS.showScreen, browserId),
        requestStream: async (input) => {
          const stream = await transport.requestStream(
            PILOT_OPERATIONS.requestScreenStream,
            [input],
            { timeoutMs: 10_000 },
          );
          window.postMessage({
            type: 'piskie-screen-stream-port',
            requestId: input.requestId,
            browserId: input.browserId,
          }, '*', [stream.port]);
        },
      },
      embeddedBrowser: {
        navigate: (url) => request(PILOT_OPERATIONS.navigateEmbeddedBrowser, url),
        openLocalHtml: (path) => request(PILOT_OPERATIONS.openLocalHtmlInEmbeddedBrowser, path),
        back: () => request(PILOT_OPERATIONS.backEmbeddedBrowser),
        forward: () => request(PILOT_OPERATIONS.forwardEmbeddedBrowser),
        reload: () => request(PILOT_OPERATIONS.reloadEmbeddedBrowser),
        stop: () => request(PILOT_OPERATIONS.stopEmbeddedBrowser),
        setBounds: (bounds) => request(PILOT_OPERATIONS.setEmbeddedBrowserBounds, bounds),
        setVisible: (visible) => request(PILOT_OPERATIONS.setEmbeddedBrowserVisible, visible),
        state: () => request(PILOT_OPERATIONS.embeddedBrowserState),
        observeState: (listener) => observe(PILOT_TOPICS.embeddedBrowser, listener),
      },
    },
    messaging: {
      listConnectors: () => request(MESSAGING_OPERATIONS.listConnectors),
      saveBot: (config) => request(MESSAGING_OPERATIONS.saveBot, config),
      deleteBot: (botId) => request(MESSAGING_OPERATIONS.deleteBot, botId),
      startBot: (botId) => request(MESSAGING_OPERATIONS.startBot, botId),
      stopBot: (botId) => request(MESSAGING_OPERATIONS.stopBot, botId),
      status: () => request(MESSAGING_OPERATIONS.status),
      pendingAuthorization: () => request(MESSAGING_OPERATIONS.pendingAuthorization),
      approve: (requestId) => request(MESSAGING_OPERATIONS.approve, requestId),
      reject: (requestId) => request(MESSAGING_OPERATIONS.reject, requestId),
      authorizedUsers: () => request(MESSAGING_OPERATIONS.authorizedUsers),
      addAuthorizedUser: (botId, senderId, senderName) => (
        request(MESSAGING_OPERATIONS.addAuthorizedUser, botId, senderId, senderName)
      ),
      removeAuthorizedUser: (botId, senderId) => (
        request(MESSAGING_OPERATIONS.removeAuthorizedUser, botId, senderId)
      ),
      startQrLogin: (botId, channelType, force) => (
        request(MESSAGING_OPERATIONS.startQrLogin, botId, channelType, force)
      ),
      waitForQrLogin: (botId, channelType) => (
        request(MESSAGING_OPERATIONS.waitForQrLogin, botId, channelType)
      ),
      submitQrCode: (botId, channelType, code) => (
        request(MESSAGING_OPERATIONS.submitQrCode, botId, channelType, code)
      ),
      cancelQrLogin: (botId, channelType) => (
        request(MESSAGING_OPERATIONS.cancelQrLogin, botId, channelType)
      ),
      logoutAccount: (botId) => request(MESSAGING_OPERATIONS.logoutAccount, botId),
      observeStatus: (listener) => observe(MESSAGING_TOPICS.status, listener),
      observeAuthorization: (listener) => observe(MESSAGING_TOPICS.authorization, listener),
    },
    observability: {
      incidents: {
        clear: (incidentId) => request(OBSERVABILITY_OPERATIONS.clearIncident, incidentId),
        clearAll: () => request(OBSERVABILITY_OPERATIONS.clearIncidents),
        observe: (observer) => transport.subscribe(OBSERVABILITY_TOPICS.incidents, observer),
      },
      systemLogs: {
        query: (filter) => request(OBSERVABILITY_OPERATIONS.querySystemLogs, filter),
        files: () => request(OBSERVABILITY_OPERATIONS.systemLogFiles),
        export: (filter, suggestedName) => (
          request(OBSERVABILITY_OPERATIONS.exportSystemLogs, filter, suggestedName)
        ),
      },
      occupancy: {
        list: () => request(OBSERVABILITY_OPERATIONS.listOccupancy),
        observe: (listener) => observe(OBSERVABILITY_TOPICS.occupancy, listener),
      },
      clientLogs: {
        record: (input) => request(OBSERVABILITY_OPERATIONS.recordClientLog, input),
      },
    },
    desktop: {
      system: {
        platform: options.platform,
        info: () => request(DESKTOP_OPERATIONS.info),
        openDevTools: () => request(DESKTOP_OPERATIONS.openDevTools),
        openExternal: (url) => request(DESKTOP_OPERATIONS.openExternal, url),
        openPath: (path) => request(DESKTOP_OPERATIONS.openPath, path),
        revealPath: (path) => request(DESKTOP_OPERATIONS.revealPath, path),
        openWorkspace: (workspace) => request(DESKTOP_OPERATIONS.openWorkspace, workspace),
        openAgentRunTrace: (agentId) => request(
          DESKTOP_OPERATIONS.openAgentRunTrace,
          agentId,
        ),
        clipboardAttachments: () => request(DESKTOP_OPERATIONS.clipboardAttachments),
        observeNetwork: (listener) => observe(DESKTOP_TOPICS.network, listener),
      },
      files: {
        preview: (path) => request(DESKTOP_OPERATIONS.previewFile, path),
        select: (input) => waitForUser(DESKTOP_OPERATIONS.selectFiles, input),
      },
      theme: {
        pickBackground: () => request(DESKTOP_OPERATIONS.pickBackground),
        clearBackground: () => request(DESKTOP_OPERATIONS.clearBackground),
        setColorScheme: (colorScheme) => request(DESKTOP_OPERATIONS.setColorScheme, colorScheme),
      },
    },
  };

  return deepFreeze(api);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
