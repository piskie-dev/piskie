import fs from 'node:fs';
import path from 'node:path';
import type { ConfigHost } from '../../config/host/config-host.js';
import {
  applyConfigPatch,
  escapeConfigPointer,
  patchConfigFields,
} from '../../config/host/config-mutations.js';
import type { BrowserControlPort } from '../../core/pilot/pilot-manager.js';
import {
  downloadEvents,
  ensureBinary,
  type DownloadProgress,
} from '../../piskiepilot/browser/fingerprint/downloader.js';
import { getKernelStatus } from '../../piskiepilot/browser/fingerprint/binary.js';
import type { BrowserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';
import type { ScreenService } from '../../services/screen.service.js';
import type { ScreenStreamService } from '../../services/screen-stream.service.js';
import type { DesktopPresentationPort } from '../../desktop/desktop-presentation-port.js';
import { createUuid } from '@shared/utils/identifiers.js';
import type {
  BrowserEnvironment,
  CreateBrowserEnvironmentRequest,
  BrowserEnvironmentGroup,
} from '../../../shared/types/index.js';
import type { ScreenStreamRequest } from '../../../shared/types/stream.js';
import type { ConfigPatchOperation } from '../../../shared/types/index.js';
import { PublicOperationError } from '../public-errors.js';
export class PilotApplication {
  constructor(
    private readonly dependencies: {
      config: ConfigHost;
      environments: BrowserEnvironmentRuntime;
      screens: ScreenService;
      streams: ScreenStreamService;
      browser: Pick<BrowserControlPort, 'deleteUserDataById'>;
      presentation: DesktopPresentationPort;
    }
  ) {}

  listEnvironments(): BrowserEnvironment[] {
    return this.dependencies.environments.listEnvironments();
  }

  getEnvironment(environmentId: string): BrowserEnvironment | undefined {
    return this.dependencies.environments.getEnvironment(environmentId);
  }

  async createEnvironment(input: CreateBrowserEnvironmentRequest): Promise<BrowserEnvironment> {
    const id = createUuid();
    const value = {
      ...input,
      identityPolicy: input.identityPolicy ?? {
        timezone: { mode: 'ip' },
        geolocation: { mode: 'ip' },
        language: { mode: 'ip' },
      },
    };
    const result = await applyConfigPatch<{
      revision: number;
      environments: Record<string, Omit<BrowserEnvironment, 'id'>>;
    }>(this.dependencies.config, 'browser-profiles', [
      {
        op: 'add',
        path: `/environments/${escapeConfigPointer(id)}`,
        value,
      },
    ]);
    return { id, ...result.current.environments[id] } as BrowserEnvironment;
  }

  async updateEnvironment(
    id: string,
    updates: Partial<BrowserEnvironment>
  ): Promise<BrowserEnvironment> {
    const current = await this.dependencies.config.show<{
      revision: number;
      environments: Record<string, Record<string, unknown>>;
    }>('browser-profiles');
    const existing = current.environments[id];
    if (!existing) throw new PublicOperationError('not-found', 'Browser environment was not found');
    const patch = patchConfigFields(
      `/environments/${escapeConfigPointer(id)}`,
      existing,
      updates as Record<string, unknown>,
      new Set([
        'name',
        'purpose',
        'groupId',
        'platform',
        'identityPolicy',
        'proxyId',
        'extensionIds',
      ])
    );
    const result = await applyConfigPatch<typeof current>(
      this.dependencies.config,
      'browser-profiles',
      patch,
      current.revision
    );
    return { id, ...result.current.environments[id] } as unknown as BrowserEnvironment;
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    const environment = this.dependencies.environments.getEnvironment(environmentId);
    if (!environment) {
      throw new PublicOperationError('not-found', 'Browser environment was not found');
    }
    await applyConfigPatch(this.dependencies.config, 'browser-profiles', [
      {
        op: 'remove',
        path: `/environments/${escapeConfigPointer(environmentId)}`,
      },
    ]);
    await this.dependencies.browser.deleteUserDataById(environment.userDataId ?? environmentId);
  }

  listGroups(): BrowserEnvironmentGroup[] {
    return this.dependencies.environments.listGroups();
  }

  async createGroup(name: string): Promise<BrowserEnvironmentGroup> {
    const id = createUuid();
    const result = await applyConfigPatch<{
      revision: number;
      groups: Record<string, Omit<BrowserEnvironmentGroup, 'id'>>;
    }>(this.dependencies.config, 'browser-profiles', [
      {
        op: 'add',
        path: `/groups/${escapeConfigPointer(id)}`,
        value: { name },
      },
    ]);
    return { id, ...result.current.groups[id] } as BrowserEnvironmentGroup;
  }

  async deleteGroup(groupId: string): Promise<void> {
    const current = await this.dependencies.config.show<{
      revision: number;
      groups: Record<string, unknown>;
      environments: Record<string, { groupId?: string }>;
    }>('browser-profiles');
    if (!current.groups[groupId])
      throw new PublicOperationError('not-found', 'Browser environment group was not found');
    const patch: ConfigPatchOperation[] = Object.entries(current.environments)
      .filter(([, environment]) => environment.groupId === groupId)
      .map(([environmentId]) => ({
        op: 'remove' as const,
        path: `/environments/${escapeConfigPointer(environmentId)}/groupId`,
      }));
    patch.push({ op: 'remove', path: `/groups/${escapeConfigPointer(groupId)}` });
    await applyConfigPatch(this.dependencies.config, 'browser-profiles', patch, current.revision);
  }

  startEnvironment(environmentId: string) {
    return this.dependencies.environments.startBrowser(environmentId);
  }

  stopEnvironment(environmentId: string) {
    return this.dependencies.environments.stopBrowser(environmentId);
  }

  showEnvironmentWindow(environmentId: string) {
    return this.dependencies.environments.revealEnvironmentWindow(environmentId);
  }

  captureLoginTrail(environmentId: string) {
    return this.dependencies.environments.captureLoginTrail(environmentId);
  }

  kernelStatus() {
    return getKernelStatus();
  }

  async installKernel() {
    await ensureBinary();
    return getKernelStatus();
  }

  subscribeKernel(listener: (progress: DownloadProgress) => void): () => void {
    downloadEvents.on('progress', listener);
    return () => downloadEvents.off('progress', listener);
  }

  screenSnapshot(browserId: string, quality?: number) {
    return this.dependencies.screens.getSnapshot(browserId, quality);
  }

  async showScreen(browserId: string): Promise<void> {
    if (!(await this.dependencies.screens.showWindow(browserId))) {
      throw new PublicOperationError('not-found', 'Browser window was not found');
    }
  }

  requestScreenStream(request: ScreenStreamRequest) {
    return this.dependencies.streams.open(request);
  }

  embeddedBrowser(windowId: number) {
    return this.dependencies.presentation.embeddedBrowser(windowId);
  }

  async navigateEmbeddedBrowser(windowId: number, address: string): Promise<void> {
    if (!(await this.embeddedBrowser(windowId).navigate(address))) {
      throw new PublicOperationError('invalid-input', 'The browser address is not allowed');
    }
  }

  async openLocalHtmlInEmbeddedBrowser(windowId: number, targetPath: string): Promise<void> {
    if (!path.isAbsolute(targetPath)) {
      throw new PublicOperationError('invalid-input', 'An absolute path is required');
    }

    let resolved: string;
    let stats: fs.Stats;
    try {
      resolved = await fs.promises.realpath(targetPath);
      stats = await fs.promises.stat(resolved);
    } catch {
      throw new PublicOperationError('not-found', 'The requested HTML file does not exist');
    }
    if (!stats.isFile()) {
      throw new PublicOperationError('invalid-input', 'A regular file is required');
    }
    if (!['.html', '.htm'].includes(path.extname(resolved).toLowerCase())) {
      throw new PublicOperationError('unsupported', 'Only HTML files can be opened here');
    }

    await this.embeddedBrowser(windowId).openLocalHtml(resolved);
  }
}
