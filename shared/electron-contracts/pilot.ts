import type { EmbeddedBrowserState } from '../types/embedded-browser.js';
import type { AgentTarget } from '../types/agent-control.js';
import type {
  BrowserEnvironment,
  CreateBrowserEnvironmentRequest,
  BrowserEnvironmentGroup,
  ScreenFrame,
} from '../types/index.js';
import type { ScreenStreamRequest } from '../types/stream.js';

export const PILOT_OPERATIONS = Object.freeze({
  listEnvironments: 'pilot.environments.list',
  getEnvironment: 'pilot.environments.get',
  createEnvironment: 'pilot.environments.create',
  updateEnvironment: 'pilot.environments.update',
  deleteEnvironment: 'pilot.environments.delete',
  listEnvironmentGroups: 'pilot.environments.listGroups',
  createEnvironmentGroup: 'pilot.environments.createGroup',
  deleteEnvironmentGroup: 'pilot.environments.deleteGroup',
  startEnvironment: 'pilot.environments.start',
  stopEnvironment: 'pilot.environments.stop',
  showEnvironmentWindow: 'pilot.environments.showWindow',
  captureEnvironmentLoginTrail: 'pilot.environments.captureLoginTrail',
  kernelStatus: 'pilot.environments.kernelStatus',
  installKernel: 'pilot.environments.installKernel',
  screenSnapshot: 'pilot.screen.snapshot',
  showScreen: 'pilot.screen.show',
  requestScreenStream: 'pilot.screen.requestStream',
  openEmbeddedBrowser: 'pilot.embeddedBrowser.open',
  closeEmbeddedBrowser: 'pilot.embeddedBrowser.close',
  navigateEmbeddedBrowser: 'pilot.embeddedBrowser.navigate',
  openLocalHtmlInEmbeddedBrowser: 'pilot.embeddedBrowser.openLocalHtml',
  backEmbeddedBrowser: 'pilot.embeddedBrowser.back',
  forwardEmbeddedBrowser: 'pilot.embeddedBrowser.forward',
  reloadEmbeddedBrowser: 'pilot.embeddedBrowser.reload',
  stopEmbeddedBrowser: 'pilot.embeddedBrowser.stop',
  setEmbeddedBrowserBounds: 'pilot.embeddedBrowser.setBounds',
  setEmbeddedBrowserVisible: 'pilot.embeddedBrowser.setVisible',
  embeddedBrowserState: 'pilot.embeddedBrowser.state',
} as const);

export const PILOT_TOPICS = Object.freeze({
  kernel: 'pilot.environments.kernel',
  embeddedBrowser: 'pilot.embeddedBrowser.state',
} as const);

interface KernelStatus {
  hostKey: string;
  installed: boolean;
  hasAsset: boolean;
  version: string;
  progress?: {
    hostKey: string;
    phase: 'download' | 'verify' | 'extract' | 'done' | 'error';
    received?: number;
    total?: number;
    message?: string;
  };
}

interface EnvironmentsClient {
  list(): Promise<BrowserEnvironment[]>;
  get(environmentId: string): Promise<BrowserEnvironment | undefined>;
  create(input: CreateBrowserEnvironmentRequest): Promise<BrowserEnvironment>;
  update(id: string, updates: Partial<BrowserEnvironment>): Promise<BrowserEnvironment | undefined>;
  delete(environmentId: string): Promise<void>;
  listGroups(): Promise<BrowserEnvironmentGroup[]>;
  createGroup(name: string): Promise<BrowserEnvironmentGroup>;
  deleteGroup(groupId: string): Promise<void>;
  start(environmentId: string): Promise<BrowserEnvironment>;
  stop(environmentId: string): Promise<BrowserEnvironment>;
  showWindow(environmentId: string): Promise<boolean>;
  captureLoginTrail(environmentId: string): Promise<Array<{ host: string; jar: number }>>;
  kernelStatus(): Promise<KernelStatus>;
  installKernel(): Promise<KernelStatus>;
  observeKernel(listener: (status: NonNullable<KernelStatus['progress']>) => void): () => void;
}

interface ScreenClient {
  snapshot(browserId: string, quality?: number): Promise<ScreenFrame>;
  show(browserId: string): Promise<void>;
  requestStream(input: ScreenStreamRequest): Promise<void>;
}

interface EmbeddedBrowserClient {
  open(target: AgentTarget): Promise<void>;
  close(target: AgentTarget): Promise<void>;
  navigate(target: AgentTarget, url: string): Promise<void>;
  openLocalHtml(target: AgentTarget, path: string): Promise<void>;
  back(target: AgentTarget): Promise<void>;
  forward(target: AgentTarget): Promise<void>;
  reload(target: AgentTarget): Promise<void>;
  stop(target: AgentTarget): Promise<void>;
  setBounds(target: AgentTarget, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  setVisible(target: AgentTarget, visible: boolean): Promise<void>;
  state(target: AgentTarget): Promise<EmbeddedBrowserState>;
  observeState(target: AgentTarget, listener: (state: EmbeddedBrowserState) => void): () => void;
}

export interface PilotClient {
  readonly environments: EnvironmentsClient;
  readonly screen: ScreenClient;
  readonly embeddedBrowser: EmbeddedBrowserClient;
}
