import { JSDOM } from 'jsdom';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import { GuideLibrary } from '../GuideLibrary';
import { AutoGuide } from '../AutoGuide';
import { useGuideStore } from '../guideStore';
import { TaskDefinitionLauncher } from '../../console/shell/TaskDefinitionLauncher';
import { useHeaderAction } from '../../console/shell/useHeaderAction';
import { AgentManagementPage } from '../../agents/AgentManagementPage';
import { useWorkerPreferencesStore } from '../../agents/worker-preferences-store';
import { useInferenceStore } from '../../../store/inferenceStore';

// Animation rendering is covered separately; exercise real dialogs, buttons, records and routing here.
vi.mock('../PlanModeScene', () => ({ PlanModeScene: () => null }));
vi.mock('../WorkflowScene', () => ({ WorkflowScene: () => null }));
vi.mock('../../../renderer-runtime/hooks', () => ({
  useRendererRuntime: () => ({ agentControl: { state: { getState: () => ({ agentsById: {} }) } } }),
}));

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let location: ReturnType<typeof useLocation>;
let navigate: ReturnType<typeof useNavigate>;
let now = Date.now();
const onNewChat = vi.fn();
const onNewTemplate = vi.fn();
const onReveal = vi.fn();

function ConsoleDestination() {
  useHeaderAction({ onNewChat, onNewTemplate, onReveal });
  return null;
}

function Harness({ children }: { children?: React.ReactNode }) {
  const currentLocation = useLocation();
  const currentNavigate = useNavigate();
  useEffect(() => { location = currentLocation; navigate = currentNavigate; }, [currentLocation, currentNavigate]);
  return currentLocation.pathname === '/console'
    ? createElement(ConsoleDestination)
    : children ?? createElement(GuideLibrary);
}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
  const popovers = new WeakSet<Element>();
  const matches = dom.window.Element.prototype.matches;
  dom.window.Element.prototype.matches = function (selector) {
    return selector === ':popover-open' ? popovers.has(this) : matches.call(this, selector);
  };
  dom.window.HTMLElement.prototype.showPopover = function () { popovers.add(this); };
  dom.window.HTMLElement.prototype.hidePopover = function () { popovers.delete(this); };
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  now += 180_000;
  vi.setSystemTime(now);
  await i18n.changeLanguage('zh-CN');
  useGuideStore.setState({ statuses: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(children?: React.ReactNode) {
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ['/preferences?sect=guides'] },
    createElement(Harness, null, children),
  )));
}

async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

describe('guide actions', () => {
  it.each(['new', 'configured', 'draft'] as const)('introduces Agent management only for a fresh visit (%s)', async (scenario) => {
    const workers = useWorkerPreferencesStore.getState();
    const inference = useInferenceStore.getState();
    try {
      useInferenceStore.setState({ refresh: async () => {} });
      useWorkerPreferencesStore.setState({
        document: { schemaVersion: 1, revision: 1, profiles: scenario === 'configured' ? { explore: { displayName: 'Explorer' } } : {} },
        types: [{ type: 'explore', description: '' }], selected: 'explore',
        drafts: scenario === 'draft' ? { explore: { displayName: 'Draft', value: { mode: 'inherit' }, conflict: false } } : {},
        loading: false, loadError: null, saving: null, refresh: async () => {},
      });
      await render(createElement(AgentManagementPage));
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(Boolean(document.querySelector('dialog[open]'))).toBe(scenario === 'new');
      if (scenario === 'new') {
        await click('dialog[open] footer button:last-child');
        expect(useGuideStore.getState().statuses.agents).toBe('understood');
        await act(async () => root.render(null));
        await render(createElement(AgentManagementPage));
        await act(async () => vi.advanceTimersByTimeAsync(650));
        expect(document.querySelector('dialog[open]')).toBeNull();
      }
    } finally {
      await act(async () => root.render(null));
      useWorkerPreferencesStore.setState(workers, true);
      useInferenceStore.setState(inference, true);
    }
  });

  it.each([
    ['model-setup', '/preferences?sect=ai'],
    ['getting-started', '/console'],
    ['browser', '/browser'],
    ['extensions', '/market?view=marketplace&kind=skill'],
    ['messaging', '/messaging'],
    ['templates', '/console'],
    ['mcp', '/market?view=marketplace&kind=mcp'],
    ['proxy', '/preferences?sect=proxy'],
    ['image', '/preferences?sect=image'],
    ['agents', '/agents'],
  ] as const)('settings replay of %s has a working action and records completion', async (id, destination) => {
    await render();
    await click(`[data-guide-id="${id}"]`);
    const buttons = document.querySelectorAll('dialog[open] footer button');
    expect([...buttons].map((button) => button.textContent)).toEqual([
      id === 'model-setup' ? i18n.t('guides.configure') : '去试试', '我知道了',
    ]);
    await click('dialog[open] footer button:first-of-type');
    expect(location.pathname + location.search).toBe(destination);
    expect(useGuideStore.getState().statuses[id]).toBe('understood');
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(onNewChat).toHaveBeenCalledTimes(id === 'getting-started' ? 1 : 0);
    expect(onNewTemplate).toHaveBeenCalledTimes(id === 'templates' ? 1 : 0);
    if (id === 'getting-started' || id === 'templates') {
      expect(location.state).toBeNull();
      await act(async () => navigate(-1));
      await act(async () => navigate(1));
      expect(onNewChat).toHaveBeenCalledTimes(id === 'getting-started' ? 1 : 0);
      expect(onNewTemplate).toHaveBeenCalledTimes(id === 'templates' ? 1 : 0);
    }
  });

  it('understood closes without navigating, with translated actions on replay', async () => {
    await i18n.changeLanguage('en-US');
    await render();
    await click('[data-guide-id="browser"]');
    expect(document.querySelector('dialog[open] footer button')?.textContent).toBe('Try it');
    await click('dialog[open] footer button:last-child');
    expect(location.pathname + location.search).toBe('/preferences?sect=guides');
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(useGuideStore.getState().statuses.browser).toBe('understood');
  });

  it('automatically shown guides use the contextual action instead of navigating', async () => {
    const onAction = vi.fn();
    await render(createElement(AutoGuide, { id: 'browser', ready: true, eligible: true, onAction }));
    await act(async () => vi.advanceTimersByTimeAsync(650));
    await click('dialog[open] footer button:first-of-type');
    expect(onAction).toHaveBeenCalledOnce();
    expect(location.pathname).toBe('/preferences');
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(useGuideStore.getState().statuses.browser).toBe('understood');
  });

  it('template try-it opens creation once without reopening the launcher popover', async () => {
    const onCreate = vi.fn();
    await render(createElement(TaskDefinitionLauncher, {
      definitions: [], definitionsReady: true, onCreate, onStart: vi.fn(),
      trigger: createElement('button', { 'aria-label': i18n.t('sessionWorkbenchUi.sidebar.startTask') }, i18n.t('sessionWorkbenchUi.sidebar.startTask')),
    }));
    await click(`button[aria-label="${i18n.t('sessionWorkbenchUi.sidebar.startTask')}"]`);
    await click('dialog[open] footer button:first-of-type');
    expect(onCreate).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(document.querySelector('[popover]')?.matches(':popover-open')).toBe(false);
    expect(useGuideStore.getState().statuses.templates).toBe('understood');
  });
});
