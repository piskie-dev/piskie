import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { act, createElement, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDefinitionSnapshot } from '../../../../shared/electron-contracts/task-definitions.js';
import type { ControllerContext } from '../../catalog.js';
import type { ElectronPreloadClient } from '../../../transport/electron/preload-client.js';
import { createElectronPiskieClient } from '../../../transport/electron/piskie-client.js';
import { ConfigHost } from '../../../config/host/config-host.js';
import { ConfigDomainRegistry } from '../../../config/core/registry.js';
import { configDomainStoragePaths } from '../../../config/core/storage-layout.js';
import { createTaskDefinitionsDomain } from '../../../config/domains/task-definitions.adapter.js';
import { TaskDefinitionStore } from '../../../core/storage/task-definition-store.js';
import { testConfig, testModel } from '../../../inference/control/__tests__/fixtures.js';
import { TaskDefinitionApplication } from '../task-definition-application.js';
import { createTaskDefinitionController } from '../task-definition-controller.js';
import { LoadoutRail } from '../../../../src/components/task-definition/LoadoutRail';
import { blankDraft, draftFromTaskDefinition, draftReducer, draftToTaskDefinitionInput, draftToTaskDefinitionUpdateInput } from '../../../../src/components/task-definition/task-draft';
import { useInferenceStore } from '../../../../src/store/inferenceStore';

vi.mock('../../../../src/shortcuts', () => ({ useDismissShortcutScope: () => undefined }));
const browsers = vi.hoisted(() => ({ environments: [], isLoading: false, fetchEnvironments: async () => undefined }));
vi.mock('../../../../src/store/browserEnvironmentStore', () => ({
  useBrowserEnvironmentStore: (select: (state: typeof browsers) => unknown) => select(browsers),
}));

const initialInference = useInferenceStore.getState();
const model = { providerId: 'primary', modelId: 'chat' };
let directory: string;
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-template-model-'));
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useInferenceStore.setState({ ...initialInference, config: testConfig(), models: { ai: [testModel()], image: [] },
    availableTargets: { ai: [{ ...model, catalogId: 'custom/chat' }], image: [] },
    selections: { schemaVersion: 1, revision: 1, ai: model },
    refresh: async () => undefined, subscribeToConfigChanges: () => () => undefined });
});
afterEach(async () => {
  await act(async () => root.unmount());
  useInferenceStore.setState(initialInference, true);
  dom.window.close();
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const registry = new ConfigDomainRegistry();
  const definitions = new TaskDefinitionStore();
  registry.register(createTaskDefinitionsDomain(directory, { publish: (snapshot) => definitions.publish(snapshot) }, async () => ({ revision: 0, bots: {}, schedules: {} })));
  const config = new ConfigHost(registry);
  await config.initialize();
  const application = new TaskDefinitionApplication({ config, definitions, messaging: {} as never,
    definitionIds: { allocate: async () => 'td-sample' } as never });
  const operations = createTaskDefinitionController(application);
  const context: ControllerContext = { generation: 'sample-generation', connectionId: 'sample-connection', windowId: 1, signal: new AbortController().signal };
  const request = vi.fn(async (id: string, args: unknown[]) => {
    const operation = operations.find((entry) => entry.id === id)!;
    // Exercise the serializable public request: undefined properties disappear, null survives.
    const wireArgs = JSON.parse(JSON.stringify(args));
    return JSON.parse(JSON.stringify(await operation.execute(context, operation.input.parse(wireArgs))));
  });
  const client = createElectronPiskieClient({ transport: { request } as unknown as ElectronPreloadClient,
    version: 'sample', platform: 'linux', getPathForFile: () => '' }).taskDefinitions;
  const readStored = async () => JSON.parse(await fs.readFile(configDomainStoragePaths(directory, 'task-definitions').configFile, 'utf8'));
  return { client, readStored, request };
}

function modelPanelButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((entry) => entry.textContent?.includes(text));
  expect(button).toBeDefined();
  return button!;
}

describe('Template model public persistence', () => {
  it('selects and clears a fixed model through the editor, serialized IPC contract and durable config', async () => {
    const { client, readStored, request } = await fixture();
    const original = await client.create(draftToTaskDefinitionInput({ ...blankDraft(false), name: 'Sample template', brief: 'Perform the sample task.' }));
    expect(original.model).toBeUndefined();
    let pending: Promise<TaskDefinitionSnapshot> | undefined;
    function Editor({ definition }: { definition: TaskDefinitionSnapshot }) {
      const [draft, dispatch] = useReducer(draftReducer, definition, draftFromTaskDefinition);
      return createElement('div', null,
        createElement(LoadoutRail, { draft, patch: (patch) => dispatch({ kind: 'patch', patch }), mcp: { picks: [], loading: false, failure: null } }),
        createElement('button', { 'data-save': true, onClick: () => { pending = client.update(definition.definitionId, draftToTaskDefinitionUpdateInput(draft, definition)); } }, 'Save'));
    }
    await act(async () => root.render(createElement(Editor, { definition: original })));
    expect(container.querySelector('[data-tile="model"]')?.textContent).toContain('Primary / Test Chat');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-tile="model"] button')!.click());
    await act(async () => modelPanelButton('primary / chat').click());
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-save]')!.click(); await pending; });
    expect((await readStored()).definitions['td-sample'].model).toEqual(model);
    const fixed = (await client.list())[0]!;
    expect(fixed.model).toEqual(model);
    expect((await client.update(fixed.definitionId, { name: 'Renamed template' })).model).toEqual(model);

    await act(async () => root.render(createElement(Editor, { key: 'reopened', definition: fixed })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-tile="model"] button')!.click());
    await act(async () => modelPanelButton('跟随全局默认').click());
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-save]')!.click(); await pending; });
    expect(request.mock.calls.at(-1)?.[1]).toEqual(['td-sample', expect.objectContaining({ model: null })]);
    expect((await readStored()).definitions['td-sample']).not.toHaveProperty('model');
    expect((await client.list())[0]?.model).toBeUndefined();
  });

  it('keeps an unavailable saved target identifiable and selectable only through clearing or an available replacement', async () => {
    const { client } = await fixture();
    const saved = await client.create({ name: 'Sample template', description: '', promptTemplate: 'Sample task', purpose: 'general',
      model: { providerId: 'removed-provider', modelId: 'retired-model' } });
    const patch = vi.fn();
    await act(async () => root.render(createElement(LoadoutRail, { draft: draftFromTaskDefinition(saved), patch, mcp: { picks: [], loading: false, failure: null } })));
    const tile = container.querySelector('[data-tile="model"]')!;
    expect(tile.textContent).toContain('模板指定');
    expect(tile.textContent).toContain('removed-provider / retired-model');
    expect(tile.textContent).toContain('当前不可用');
    await act(async () => tile.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('removed-provider / retired-model');
    await act(async () => modelPanelButton('跟随全局默认').click());
    expect(patch).toHaveBeenLastCalledWith({ model: undefined });
  });
});
