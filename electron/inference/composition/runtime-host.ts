import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { DefaultAiGateway } from '../ai/public-gateway.js';
import { bootstrapInferenceConfig, type BootstrapInferenceConfigResult } from '../control/bootstrap-config.js';
import { compileInferenceConfig } from '../control/compiler.js';
import { InferenceConfigRepository, inferenceConfigPaths } from '../control/config-repository.js';
import { InferenceControlPlane } from '../control/control-plane.js';
import {
  InferenceSelectionStore,
  type InferenceSelections,
} from '../control/selection-store.js';
import { ComfyWorkflowAssetStore } from '../control/workflow-assets.js';
import {
  type AnthropicMessagesDriverDependencies,
} from '../drivers/anthropic-messages/driver.js';
import type { ComfyWorkflowDriverDependencies } from '../drivers/comfyui-workflow/driver.js';
import type { OpenAiDriverDependencies } from '../drivers/openai/driver.js';
import { DriverRegistry } from '../drivers/registry.js';
import { LocalImageArtifactStore } from '../image/artifact-store.js';
import { ImageJobJournal } from '../image/job-journal.js';
import { DefaultImageGateway } from '../image/public-gateway.js';
import type { RuntimeReceipt } from '../control/runtime-receipt.js';
import { registerBuiltInInferenceDrivers } from './built-in-drivers.js';
import { createConfigHost } from '../../config/host/composition.js';
import type {
  ConfigHost,
  ConfigHostLifecycleReport,
} from '../../config/host/config-host.js';
import type { ConfigDomainRevisionChangedEvent } from '../../../shared/types/config.js';
import type { ConfigDomainIntegrations } from '../../config/domains/integrations.js';

export interface InferenceRuntimeHostOptions {
  rootDirectory: string;
  artifactDirectory?: string;
  imageJobDirectory?: string;
  runtimeReceiptFile?: string;
  publisher?: RuntimeReceipt['publisher'];
  openAi?: Omit<OpenAiDriverDependencies, 'artifacts' | 'imageArtifacts'>;
  anthropic?: Omit<AnthropicMessagesDriverDependencies, 'artifacts'>;
  comfyui?: Omit<ComfyWorkflowDriverDependencies, 'workflows' | 'artifacts'>;
  imageHttp?: {
    fetch?: typeof globalThis.fetch;
    resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  };
  now?: () => Date;
  onReloadError?: (error: unknown) => void;
  onSelectionsChanged?: (selections: InferenceSelections) => void | Promise<void>;
  onConfigChanged?: (event: ConfigDomainRevisionChangedEvent) => void;
  onClose?: () => void | Promise<void>;
  configIntegrations?: ConfigDomainIntegrations;
}

export interface InferenceRuntimeStartupResult {
  bootstrap?: BootstrapInferenceConfigResult;
  currentRevision?: number;
  config: ConfigHostLifecycleReport;
  restoredHistoricalRevisions: readonly number[];
  historicalRevisionErrors: readonly { revision: number; message: string }[];
  issues: readonly InferenceRuntimeStartupIssue[];
}

export interface InferenceRuntimeStartupIssue {
  stage: 'bootstrap' | 'config-host' | 'current-revision' | 'history-restore' | 'watchers';
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export class InferenceRuntimeHost {
  readonly paths;
  readonly repository: InferenceConfigRepository;
  readonly selections: InferenceSelectionStore;
  readonly artifacts: LocalImageArtifactStore;
  readonly workflows: ComfyWorkflowAssetStore;
  readonly journal: ImageJobJournal;
  readonly drivers: DriverRegistry;
  readonly control: InferenceControlPlane;
  readonly configHost: ConfigHost;
  readonly aiGateway: DefaultAiGateway;
  readonly imageGateway: DefaultImageGateway;

  private configWatcher: FSWatcher | undefined;
  private catalogWatcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private readonly domainReloadTimers = new Map<string, NodeJS.Timeout>();
  private reloadChain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: InferenceRuntimeHostOptions) {
    this.now = options.now ?? (() => new Date());
    this.paths = {
      ...inferenceConfigPaths(options.rootDirectory),
      ...(options.artifactDirectory && { artifactDirectory: options.artifactDirectory }),
      ...(options.imageJobDirectory && { imageJobDirectory: options.imageJobDirectory }),
      ...(options.runtimeReceiptFile && { runtimeReceiptFile: options.runtimeReceiptFile }),
    };
    this.repository = new InferenceConfigRepository(this.paths, {
      onHistoryMaintenanceError: options.onReloadError,
    });
    this.selections = new InferenceSelectionStore(this.paths);
    this.artifacts = new LocalImageArtifactStore(this.paths.artifactDirectory, { now: this.now });
    this.workflows = new ComfyWorkflowAssetStore(this.paths.workflowDirectory);
    this.journal = new ImageJobJournal(this.paths.imageJobDirectory, this.now);
    this.drivers = new DriverRegistry();
    registerBuiltInInferenceDrivers(this.drivers, {
      workflows: this.workflows,
      artifacts: this.artifacts,
      openAi: options.openAi,
      anthropic: options.anthropic,
      comfyui: options.comfyui,
      imageHttp: options.imageHttp,
      now: this.now,
    });
    this.control = new InferenceControlPlane({
      repository: this.repository,
      drivers: this.drivers,
      journal: this.journal,
      publisher: options.publisher ?? 'electron',
      now: this.now,
    });
    this.configHost = createConfigHost(
      {
        rootDirectory: options.rootDirectory,
        inference: this.control,
        selections: this.selections,
        integrations: options.configIntegrations,
        onSelectionsChanged: options.onSelectionsChanged,
        onHistoryMaintenanceError: options.onReloadError,
      },
      {
        onSubscriberError: (error) => this.notifyReloadError(error),
        onDomainError: (error) => this.notifyReloadError(error),
      },
    );
    if (options.onConfigChanged) this.configHost.subscribe(options.onConfigChanged);
    this.aiGateway = new DefaultAiGateway(this.control.runtime);
    this.imageGateway = new DefaultImageGateway(this.control.runtime, this.journal);
  }

  async initialize(): Promise<InferenceRuntimeStartupResult> {
    const issues: InferenceRuntimeStartupIssue[] = [];
    let bootstrap: BootstrapInferenceConfigResult | undefined;
    try {
      bootstrap = await bootstrapInferenceConfig({
        rootDirectory: this.paths.rootDirectory,
        drivers: this.drivers,
        now: this.now,
        onHistoryMaintenanceError: (error) => this.notifyReloadError(error),
      });
    } catch (cause) {
      issues.push(startupIssue('bootstrap', cause));
      this.notifyReloadError(cause);
    }

    let config: ConfigHostLifecycleReport;
    try {
      config = await this.configHost.initialize();
    } catch (cause) {
      issues.push(startupIssue('config-host', cause));
      this.notifyReloadError(cause);
      const domains = this.configHost.domains();
      config = {
        domains,
        allConfigurable: domains.every((domain) => domain.availability.configurable),
        allRuntimeActive: domains.every((domain) => domain.availability.runtimeActive),
      };
    }

    let currentRevision: number | undefined;
    try {
      currentRevision = (await this.repository.read()).revision;
    } catch (cause) {
      issues.push(startupIssue('current-revision', cause));
      this.notifyReloadError(cause);
    }

    let historical: Awaited<ReturnType<InferenceRuntimeHost['restoreHistoricalSnapshots']>> = {
      restored: [],
      errors: [],
    };
    if (currentRevision !== undefined) {
      try {
        historical = await this.restoreHistoricalSnapshots(currentRevision);
      } catch (cause) {
        issues.push(startupIssue('history-restore', cause));
        this.notifyReloadError(cause);
      }
    }

    try {
      this.startWatchers();
    } catch (cause) {
      issues.push(startupIssue('watchers', cause));
      this.notifyReloadError(cause);
    }
    return {
      ...(bootstrap && { bootstrap }),
      ...(currentRevision !== undefined && { currentRevision }),
      config,
      restoredHistoricalRevisions: historical.restored,
      historicalRevisionErrors: historical.errors,
      issues,
    };
  }

  async reloadFromDisk(force = false): Promise<void> {
    if (!force) {
      await this.configHost.reloadExternal('inference');
      return;
    }
    await this.control.publishConfigCandidate(await this.repository.read());
  }

  /** Reads the canonical selections through their current runtime-availability projection. */
  async readEffectiveSelections(): Promise<InferenceSelections> {
    return this.configHost.show<InferenceSelections>('inference-selections');
  }

  async close(): Promise<void> {
    this.configWatcher?.close();
    this.configWatcher = undefined;
    this.catalogWatcher?.close();
    this.catalogWatcher = undefined;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    for (const timer of this.domainReloadTimers.values()) clearTimeout(timer);
    this.domainReloadTimers.clear();
    await this.reloadChain.catch(() => undefined);
    await this.options.onClose?.();
  }

  private startWatchers(): void {
    if (!this.configWatcher) {
      this.configWatcher = watch(path.dirname(this.paths.configFile), (_event, fileName) => {
        const name = fileName?.toString();
        if (!name || name === path.basename(this.paths.configFile)) this.scheduleReload(false);
        if (!name) {
          for (const domain of this.configHost.domains()) {
            if (domain.id !== 'inference') this.scheduleDomainReload(domain.id);
          }
          return;
        }
        const domain = this.configHost.domains().find((entry) => `${entry.id}.json` === name)?.id;
        if (domain && domain !== 'inference') this.scheduleDomainReload(domain);
      });
      this.configWatcher.on('error', (error) => this.notifyReloadError(error));
    }
    if (!this.catalogWatcher) {
      this.catalogWatcher = watch(path.join(this.paths.rootDirectory, 'catalog'), (_event, fileName) => {
        const name = fileName?.toString();
        if (!name || name === 'models.json') {
          this.scheduleReload(true);
        }
      });
      this.catalogWatcher.on('error', (error) => this.notifyReloadError(error));
    }
  }

  private scheduleReload(force: boolean): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reloadChain = this.reloadChain
        .then(() => this.reloadFromDisk(force))
        .catch((error) => this.notifyReloadError(error));
    }, 75);
  }

  private scheduleDomainReload(domain: string): void {
    const pending = this.domainReloadTimers.get(domain);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.domainReloadTimers.delete(domain);
      this.reloadChain = this.reloadChain
        .then(() => this.configHost.reloadExternal(domain))
        .then(() => undefined)
        .catch((error) => this.notifyReloadError(error));
    }, 75);
    this.domainReloadTimers.set(domain, timer);
  }

  private async restoreHistoricalSnapshots(currentRevision: number): Promise<{
    restored: number[];
    errors: { revision: number; message: string }[];
  }> {
    const revisions = new Set(
      (await this.journal.listResumable())
        .map((record) => record.job.configRevision)
        .filter((revision) => revision !== currentRevision),
    );
    const restored: number[] = [];
    const errors: { revision: number; message: string }[] = [];
    for (const revision of [...revisions].sort((left, right) => left - right)) {
      try {
        const config = await this.repository.readRevision(revision);
        const catalog = await this.control.loadCatalogSnapshot();
        this.control.runtime.retainHistorical(
          compileInferenceConfig(config, catalog, this.drivers, this.now),
        );
        restored.push(revision);
      } catch (cause) {
        errors.push({ revision, message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    return { restored, errors };
  }

  private notifyReloadError(error: unknown): void {
    try {
      this.options.onReloadError?.(error);
    } catch {
      // Diagnostics must not change Runtime or Config Host availability.
    }
  }
}

function startupIssue(
  stage: InferenceRuntimeStartupIssue['stage'],
  cause: unknown,
): InferenceRuntimeStartupIssue {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const record = isRecord(cause) ? cause : {};
  return {
    stage,
    code: typeof record.code === 'string' ? record.code : 'INFERENCE_RUNTIME_STARTUP_FAILED',
    message: error.message,
    ...(isRecord(record.details) && { details: record.details }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
