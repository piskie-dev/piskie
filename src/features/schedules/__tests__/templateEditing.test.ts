const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const testDOM = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  vi.stubGlobal('window', testDOM.window);
  for (const name of ['document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent'] as const) {
    vi.stubGlobal(name, testDOM.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return testDOM;
});

import i18n from 'i18next';
import { act, createElement, StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskDefinitionClient, TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type { ScheduleView } from '@shared/types/schedules';
import type { ScheduleRepositorySnapshot } from '../../../domains/schedules/schedule-repository';
import { createTaskDefinitionRepository, type TaskDefinitionRepository } from '../../../domains/task-definitions/task-definition-repository';
import { RendererRuntimeContext } from '../../../renderer-runtime/renderer-runtime-context';
import type { RendererRuntime } from '../../../renderer-runtime/renderer-runtime';
import { mountShortcutListener, registerShortcutScope, resetShortcutRegistry } from '../../../shortcuts';
import ConsolePage from '../../console/ConsolePage';
import { SchedulesPage } from '../SchedulesPage';

// Exercise the actual schedule UI, repository, launcher, editor and dialog close callbacks.
// Native Escape and backdrop behavior require Chromium; JSDOM only dispatches close events.
vi.mock('../../console/shell/useConsoleShell', () => ({
  useConsoleShell: () => ({ selectedAgentId: null, mode: 'thread', previewImage: null, reveal: vi.fn(), newSession: vi.fn(), selectSession: vi.fn() }),
}));
vi.mock('../../console/shell/useConsoleKeyboard', () => ({ useConsoleKeyboard: () => {} }));
vi.mock('../../console/shell/useAgentStart', () => ({
  useAgentStart: () => ({ startTaskDefinition: vi.fn(), startQuickChat: vi.fn() }),
}));
vi.mock('../../console/data/composer-drafts', () => ({ useComposerDraftVersion: () => 0, WELCOME_DRAFT_KEY: 'welcome' }));
vi.mock('../../console/content/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('../../console/content/composer/WelcomeInput', () => ({ WelcomeInput: () => null }));
vi.mock('../../console/content/ImageLightbox', () => ({ default: () => null }));
vi.mock('../../console/modes/dock/DockMode', () => ({ DockMode: () => null }));
vi.mock('../../console/modes/thread/ThreadMode', () => ({
  ThreadMode: ({ renderTaskLauncher }: { renderTaskLauncher: (trigger: ReactNode) => ReactNode }) => (
    renderTaskLauncher(createElement('button', { type: 'button', 'aria-label': 'Open task launcher' }, 'Open task launcher'))
  ),
}));
vi.mock('../../../components/task-definition/LoadoutRail', () => ({ LoadoutRail: () => null }));
vi.mock('../../../components/task-definition/useEffectiveMcp', () => ({
  useEffectiveMcp: () => ({ picks: [], loading: false, failure: null }),
}));
vi.mock('../../../store/messagingStore', () => ({
  useMessagingStore: <T,>(selector: (state: { connections: []; fetchConnections: () => Promise<void> }) => T) => (
    selector({ connections: [], fetchConnections: async () => {} })
  ),
}));
vi.mock('../SlotGridView', () => ({ SlotGridView: () => null }));

const definitionA: TaskDefinitionSnapshot = {
  definitionId: 'template-a', name: 'Sample template A', description: '', purpose: 'general',
  promptTemplate: 'Sample prompt A', defaultModeId: 'normal', defaultApprovalMode: 'confirm',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const definitionB: TaskDefinitionSnapshot = {
  ...definitionA, definitionId: 'template-b', name: 'Sample template B', promptTemplate: 'Sample prompt B',
};
const definitions = [definitionA, definitionB];
const schedule: ScheduleView = {
  schedule: {
    scheduleId: 'schedule-a', name: 'Sample schedule', enabled: true,
    trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' }, runIfMissed: false,
    action: { kind: 'new_run', launch: { kind: 'definition', definitionId: definitionB.definitionId } },
    createdBy: { kind: 'user' }, createdAt: '2026-01-01T00:00:00.000Z',
  },
  state: { consecutiveFailures: 0 }, nextRunAt: null,
};
const client = {
  list: vi.fn<TaskDefinitionClient['list']>(),
  create: vi.fn<TaskDefinitionClient['create']>(),
  update: vi.fn<TaskDefinitionClient['update']>(),
  delete: vi.fn<TaskDefinitionClient['delete']>(),
};
const scheduleCreate = vi.fn(async () => schedule);
const scheduleUpdate = vi.fn(async () => schedule);
let taskDefinitions: TaskDefinitionRepository;
let scheduleState: StoreApi<ScheduleRepositorySnapshot>;
let runtime: RendererRuntime;
let root: Root;
let container: HTMLDivElement;
let location: ReturnType<typeof useLocation>;
let disposeShortcuts: () => void;

function Harness() {
  const currentLocation = useLocation();
  useEffect(() => { location = currentLocation; }, [currentLocation]);
  return currentLocation.pathname === '/console' ? createElement(ConsolePage) : createElement(SchedulesPage);
}

beforeAll(() => {
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
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: { desktop: { workspace: { defaultPath: async () => '/workspace/example' } } },
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  client.list.mockReset().mockResolvedValue(definitions);
  client.create.mockReset();
  client.update.mockReset();
  await i18n.changeLanguage('en-US');
  resetShortcutRegistry();
  disposeShortcuts = mountShortcutListener(dom.window as unknown as Window);
  taskDefinitions = createTaskDefinitionRepository(client);
  taskDefinitions.state.setState({ phase: 'ready', definitions, error: null, revision: 1 }, true);
  scheduleState = createStore<ScheduleRepositorySnapshot>(() => ({ phase: 'ready', items: [schedule], error: null, revision: 1 }));
  runtime = {
    taskDefinitions,
    schedules: { state: scheduleState, queryHistory: async () => [], create: scheduleCreate, update: scheduleUpdate },
    agentControl: { state: createStore(() => ({ agentsById: {} })) },
  } as unknown as RendererRuntime;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeShortcuts();
  resetShortcutRegistry();
  taskDefinitions.close();
  container.remove();
});

afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

async function render(entry = '/schedules') {
  await act(async () => root.render(createElement(StrictMode, null,
    createElement(RendererRuntimeContext.Provider, { value: runtime },
      createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Harness)),
    ),
  )));
}

function button(label: string, parent: ParentNode = container) {
  const result = [...parent.querySelectorAll<HTMLButtonElement>('button')].find((node) => (
    node.textContent?.trim() === label || node.getAttribute('aria-label') === label
  ));
  expect(result, label).toBeDefined();
  return result!;
}

async function click(label: string, parent: ParentNode = container) {
  await act(async () => button(label, parent).click());
}

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

async function choose(label: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

async function selectSchedule() {
  const row = [...container.querySelectorAll('aside button')].find((node) => node.querySelector('strong')?.textContent === schedule.schedule.name);
  expect(row).toBeDefined();
  await act(async () => (row as HTMLButtonElement).click());
}

function scheduleDialog() {
  return container.querySelector('#schedule-form-name')!.closest('dialog')!;
}

function editor() {
  return container.querySelector<HTMLDialogElement>(`dialog[open][aria-label="${i18n.t('console.editTaskTemplate')}"]`);
}

function expectEditing(definition: TaskDefinitionSnapshot) {
  const dialog = editor();
  expect(dialog).not.toBeNull();
  expect(dialog!.querySelector('input')?.value).toBe(definition.name);
  expect(dialog!.querySelector('textarea')?.value).toBe(definition.promptTemplate);
  expect(dialog!.querySelector('textarea')?.readOnly).toBe(false);
  expect(client.create).not.toHaveBeenCalled();
}

function pendingList() {
  let resolve!: (value: TaskDefinitionSnapshot[]) => void;
  client.list.mockReturnValue(new Promise<TaskDefinitionSnapshot[]>((done) => { resolve = done; }));
  return resolve;
}

async function prepareDraft(mode: 'create' | 'edit') {
  if (mode === 'edit') {
    await selectSchedule();
    await click(i18n.t('schedulesUi.action.edit'));
  } else {
    await click(i18n.t('schedulesUi.create'));
    await choose(i18n.t('schedulesUi.form.template'), definitionA.definitionId);
  }
  const definition = mode === 'create' ? definitionB : definitionA;
  await choose(i18n.t('schedulesUi.form.template'), definition.definitionId);
  const dialog = scheduleDialog();
  await fill(dialog.querySelector<HTMLInputElement>('#schedule-form-name')!, 'Draft schedule');
  await click(i18n.t('schedulesUi.form.preset.weekdays'), dialog);
  await fill(dialog.querySelector<HTMLInputElement>('#schedule-form-time')!, '14:35');
  await choose(i18n.t('schedulesUi.form.timezone'), 'Asia/Tokyo');
  await click(i18n.t('schedulesUi.form.runIfMissed'), dialog);
  return { dialog, definition };
}

function expectDraft(dialog: HTMLDialogElement, definition: TaskDefinitionSnapshot) {
  expect(location.pathname).toBe('/schedules');
  expect(scheduleDialog()).toBe(dialog);
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector<HTMLSelectElement>(`select[aria-label="${i18n.t('schedulesUi.form.template')}"]`)?.value).toBe(definition.definitionId);
  expect(dialog.querySelector<HTMLInputElement>('#schedule-form-name')?.value).toBe('Draft schedule');
  expect(dialog.querySelector<HTMLInputElement>('#schedule-form-time')?.value).toBe('14:35');
  expect(dialog.querySelector<HTMLSelectElement>(`select[aria-label="${i18n.t('schedulesUi.form.timezone')}"]`)?.value).toBe('Asia/Tokyo');
  expect(button(i18n.t('schedulesUi.form.preset.weekdays'), dialog).getAttribute('aria-pressed')).toBe('true');
  expect(button(i18n.t('schedulesUi.form.runIfMissed'), dialog).getAttribute('aria-checked')).toBe('true');
  const prompt = dialog.querySelector<HTMLTextAreaElement>('#schedule-form-prompt')!;
  expect(prompt.readOnly).toBe(true);
  expect(prompt.value).toBe(definition.promptTemplate);
}

describe('schedule template editing', () => {
  it.each([
    ['create', 'manageTemplates'], ['create', 'editTemplatePrompt'],
    ['edit', 'manageTemplates'], ['edit', 'editTemplatePrompt'],
  ] as const)('opens the selected template in place from %s %s and returns to its draft', async (mode, entry) => {
    await render();
    const { dialog, definition } = await prepareDraft(mode);
    await click(i18n.t(`schedulesUi.form.${entry}`), dialog);
    expectEditing(definition);
    expectDraft(dialog, definition);
    await click(i18n.t('common.cancel'), editor()!);
    expect(editor()).toBeNull();
    expectDraft(dialog, definition);
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });

  it.each(['footer', 'header', 'native'] as const)('retains the underlying form on %s dismissal', async (dismissal) => {
    await i18n.changeLanguage('zh-CN');
    await render();
    const { dialog, definition } = await prepareDraft('create');
    await click(i18n.t('schedulesUi.form.editTemplatePrompt'), dialog);
    const taskEditor = editor()!;
    await fill(taskEditor.querySelector('textarea')!, 'Unsaved sample prompt');
    const lowerAction = vi.fn();
    const unregister = registerShortcutScope({
      id: 'sample-page', layer: 'page', blocksLowerLayers: 'none',
      bindings: [{
        id: 'sample-page:dismiss', commandId: 'sample.dismiss', combo: 'escape', enabled: () => true,
        allowInEditable: true, handling: 'execute', defaultBehavior: 'prevent', execute: lowerAction,
      }],
    });
    await act(async () => {
      if (dismissal === 'native') {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        taskEditor.querySelector('textarea')!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        taskEditor.close();
      } else {
        taskEditor.querySelector<HTMLButtonElement>(`${dismissal} button[type="button"]`)!.click();
      }
    });
    expect(editor()).toBeNull();
    expectDraft(dialog, definition);
    expect(lowerAction).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
    unregister();
    await click(i18n.t('schedulesUi.form.manageTemplates'), dialog);
    expectEditing(definition);
  });

  it.each(['create', 'edit'] as const)('shows the saved prompt immediately and submits the continued %s draft', async (mode) => {
    await render();
    const { dialog, definition } = await prepareDraft(mode);
    await click(i18n.t('schedulesUi.form.editTemplatePrompt'), dialog);
    const updated = { ...definition, name: 'Updated sample template', promptTemplate: 'Changed sample prompt' };
    client.update.mockResolvedValueOnce(updated);
    const resolveList = pendingList();
    await fill(editor()!.querySelector('textarea')!, updated.promptTemplate);
    await click(i18n.t('common.save'), editor()!);
    expect(client.update).toHaveBeenCalledWith(definition.definitionId, expect.objectContaining({ promptTemplate: updated.promptTemplate }));
    expect(editor()).toBeNull();
    expect(taskDefinitions.state.getState().phase).toBe('refreshing');
    expectDraft(dialog, updated);
    expect(scheduleCreate).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
    await fill(dialog.querySelector<HTMLInputElement>('#schedule-form-name')!, 'Continued sample schedule');
    await fill(dialog.querySelector<HTMLInputElement>('#schedule-form-time')!, '16:20');
    await click(i18n.t(mode === 'create' ? 'schedulesUi.form.submitCreate' : 'schedulesUi.form.submitSave'), dialog);
    const payload = {
      name: 'Continued sample schedule', runIfMissed: true,
      trigger: { kind: 'cron', expression: '20 16 * * 1-5', timezone: 'Asia/Tokyo' },
      action: { kind: 'new_run', launch: { kind: 'definition', definitionId: definition.definitionId } },
    };
    if (mode === 'create') expect(scheduleCreate).toHaveBeenCalledWith(payload);
    else expect(scheduleUpdate).toHaveBeenCalledWith(schedule.schedule.scheduleId, payload);
    expect(dialog.isConnected).toBe(false);
    await act(async () => resolveList(definitions.map((item) => item.definitionId === updated.definitionId ? updated : item)));
  });

  it('keeps both drafts available when saving the template fails and allows retry', async () => {
    await render();
    const { dialog, definition } = await prepareDraft('edit');
    await click(i18n.t('schedulesUi.form.manageTemplates'), dialog);
    const updated = { ...definition, promptTemplate: 'Retry sample prompt' };
    client.update.mockRejectedValueOnce(new Error('Sample save failure')).mockResolvedValueOnce(updated);
    client.list.mockResolvedValue(definitions.map((item) => item.definitionId === updated.definitionId ? updated : item));
    await fill(editor()!.querySelector('textarea')!, updated.promptTemplate);
    await click(i18n.t('common.save'), editor()!);
    expect(editor()!.querySelector('[role="alert"]')?.textContent).toBe('Sample save failure');
    expect(editor()!.querySelector('textarea')?.value).toBe(updated.promptTemplate);
    expectDraft(dialog, definition);
    await click(i18n.t('common.save'), editor()!);
    expect(editor()).toBeNull();
    expectDraft(dialog, updated);
  });

  it('edits the template in the prompt details without leaving the selected schedule', async () => {
    await render();
    await selectSchedule();
    await click(i18n.t('schedulesUi.view.prompt'));
    await click(i18n.t('schedulesUi.form.manageTemplates'));
    expectEditing(definitionB);
    expect(location.pathname).toBe('/schedules');
    const updated = { ...definitionB, promptTemplate: 'Updated detail prompt' };
    client.update.mockResolvedValueOnce(updated);
    const resolveList = pendingList();
    await fill(editor()!.querySelector('textarea')!, updated.promptTemplate);
    await click(i18n.t('common.save'), editor()!);
    expect(editor()).toBeNull();
    expect(location.pathname).toBe('/schedules');
    expect(button(i18n.t('schedulesUi.view.prompt')).getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain(updated.promptTemplate);
    expect(container.textContent).toContain(schedule.schedule.name);
    expect(scheduleUpdate).not.toHaveBeenCalled();
    await act(async () => resolveList([definitionA, updated]));
  });

  it('creates and selects a new template while retaining the schedule draft', async () => {
    await render();
    const { dialog } = await prepareDraft('create');
    await click(i18n.t('schedulesUi.form.newTemplate'), dialog);
    const creator = container.querySelector<HTMLDialogElement>(`dialog[open][aria-label="${i18n.t('console.newTaskTemplate')}"]`)!;
    expect(creator).not.toBeNull();
    const created = { ...definitionA, definitionId: 'template-c', name: 'New sample template', promptTemplate: 'New sample prompt' };
    client.create.mockResolvedValueOnce(created);
    client.list.mockResolvedValue([...definitions, created]);
    await fill(creator.querySelector('input')!, created.name);
    await fill(creator.querySelector('textarea')!, created.promptTemplate);
    await click(i18n.t('console.createWithoutRun'), creator);
    expect(creator.open).toBe(false);
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ name: created.name, promptTemplate: created.promptTemplate }));
    expectDraft(dialog, created);
    expect(scheduleCreate).not.toHaveBeenCalled();
    await click(i18n.t('schedulesUi.form.submitCreate'), dialog);
    expect(scheduleCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Draft schedule', action: { kind: 'new_run', launch: { kind: 'definition', definitionId: created.definitionId } },
    }));
  });

  it('preserves editing and save-and-start controls in the console launcher', async () => {
    await render('/console');
    await click('Open task launcher');
    await click(i18n.t('sessionWorkbenchUi.launcher.editTemplate', { name: definitionA.name }));
    expectEditing(definitionA);
    expect(button(i18n.t('console.saveAndStart'), editor()!)).toBeDefined();
  });

  it.each([
    { kind: 'inject', prompt: 'Sample agent prompt', agentId: 'agent-a' },
    { kind: 'new_run', prompt: 'Sample agent prompt', launch: { kind: 'inline', approvalMode: 'confirm' } },
  ] satisfies ScheduleView['schedule']['action'][])('keeps $kind schedules read-only without a template editor link', async (action) => {
    scheduleState.setState({ items: [{ ...schedule, schedule: { ...schedule.schedule, action, createdBy: { kind: 'agent', agentId: 'agent-a' } } }] });
    await render();
    await selectSchedule();
    await click(i18n.t('schedulesUi.action.edit'));
    const prompt = container.querySelector<HTMLTextAreaElement>('#schedule-form-prompt')!;
    expect(prompt.readOnly).toBe(true);
    expect(prompt.value).toBe(action.prompt);
    expect(container.textContent).not.toContain(i18n.t('schedulesUi.form.editTemplatePrompt'));
    expect(container.textContent).not.toContain(i18n.t('schedulesUi.form.manageTemplates'));
    await click(i18n.t('common.cancel'), scheduleDialog());
    await click(i18n.t('schedulesUi.view.prompt'));
    expect(container.textContent).toContain(action.prompt);
    expect(container.textContent).not.toContain(i18n.t('schedulesUi.form.manageTemplates'));
  });
});
