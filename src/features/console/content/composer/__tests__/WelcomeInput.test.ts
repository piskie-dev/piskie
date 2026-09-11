import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInferenceStore } from '../../../../../store/inferenceStore';
import { useUIStore } from '../../../../../store/uiStore';
import type { HistoryRow, SessionRow } from '../../../data/sessionRow';
import { rawText } from '../../../data/presentationText';
import {
  clearAllComposerDrafts,
  composerDraftKey,
  DEFAULT_COMPOSER_SETTINGS,
  useComposerDraftStore,
  useComposerDraftVersion,
  WELCOME_DRAFT_KEY,
} from '../../../data/composer-drafts';
import { useConsoleShell, type ConsoleShell } from '../../../shell/useConsoleShell';
import { useAgentStart, type AgentStart, type StartOutcome } from '../../../shell/useAgentStart';
import { useConsoleActions } from '../../../data/actions';
import { useComposerSettings, type ComposerSettings } from '../useComposerSettings';
import { WelcomeInput } from '../WelcomeInput';
import { pngBytes } from '../../../attachments/__tests__/fixtures';
import { composerImageUsage } from '../../../data/composer-drafts';
import type { WelcomeComposerProps } from '../WelcomeComposer';

const { renderComposer, runtime, control, preview, rows } = vi.hoisted(() => ({
  renderComposer: vi.fn(),
  runtime: {
    agentRuns: { refresh: vi.fn().mockResolvedValue(undefined), loadPreview: vi.fn().mockResolvedValue(null) },
    agentCommands: {
      setSubagentReasoning: vi.fn(), setSubagentModel: vi.fn(),
      setApprovalMode: vi.fn(), setSubagentApprovalMode: vi.fn(),
      respondToApproval: vi.fn(), start: vi.fn(), inject: vi.fn(), injectSubagent: vi.fn(),
    },
  },
  control: { agentsById: {} },
  preview: { state: null },
  rows: { sessions: [] as SessionRow[], history: [] as HistoryRow[] },
}));

vi.mock('../WelcomeComposer', () => ({
  WelcomeComposer: (props: WelcomeComposerProps) => {
    renderComposer(props);
    return null;
  },
}));
vi.mock('../../../../../renderer-runtime/hooks', () => ({
  useRendererRuntime: () => runtime,
  useAgentControl: (select: (state: typeof control) => unknown) => select(control),
  useAgentRunPreview: (select: (state: typeof preview) => unknown) => select(preview),
}));
vi.mock('../../../data/session', () => ({
  useSessionRows: () => rows.sessions,
  useHistoryRows: () => rows.history,
}));

const selectFolder = vi.fn();
const revokeObjectURL = vi.fn();
const onStart = vi.fn<WelcomeInputStart>();
type WelcomeInputStart = React.ComponentProps<typeof WelcomeInput>['onStart'];
const shellRef = React.createRef<ConsoleShell>();
const settingsRef = React.createRef<ComposerSettings>();
const workerSettingsRef = React.createRef<ComposerSettings>();
const actionsRef = React.createRef<ReturnType<typeof useConsoleActions>>();
const startRef = React.createRef<AgentStart>();
let root: Root;
let dom: JSDOM;

function Harness(): React.ReactElement {
  const shell = useConsoleShell();
  React.useImperativeHandle(shellRef, () => shell, [shell]);
  const settings = useComposerSettings('agent-a', undefined, 'sample-provider::default-model');
  const workerSettings = useComposerSettings('agent-a', 'worker-a', 'sample-provider::default-model');
  const actions = useConsoleActions();
  const start = useAgentStart(shell.selectSession);
  React.useImperativeHandle(settingsRef, () => settings, [settings]);
  React.useImperativeHandle(workerSettingsRef, () => workerSettings, [workerSettings]);
  React.useImperativeHandle(actionsRef, () => actions, [actions]);
  React.useImperativeHandle(startRef, () => start, [start]);
  const version = useComposerDraftVersion(WELCOME_DRAFT_KEY);
  return React.createElement(WelcomeInput, { key: version, sending: false, onStart });
}

function composer(): WelcomeComposerProps {
  return renderComposer.mock.calls.at(-1)![0] as WelcomeComposerProps;
}

async function remount(): Promise<void> {
  await act(async () => root.render(null));
  await act(async () => root.render(React.createElement(Harness)));
}

async function fillDraft(): Promise<void> {
  await act(async () => {
    composer().onChange('Inspect the sample');
    composer().onModelChange('sample-provider::chosen-model');
    composer().onModeChange('plan');
    composer().onApprovalModeChange('auto');
    composer().onEnvironmentIdsChange(['browser-a', 'browser-b']);
    composer().onSelectWorkspace();
  });
  act(() => composer().onSkillsChange(['sample-guide', 'sample-table']));
  act(() => composer().onPaste({
    clipboardData: {
      items: [{
        kind: 'file',
        getAsFile: () => new File([pngBytes()], 'sample.png', { type: 'image/png' }),
      }],
      getData: () => '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent));
  const image = composer().images[0]!;
  if (image.status === 'capturing') await act(async () => { await image.capture.done; });
}

function expectFresh(workspacePath?: string, approvalMode: 'auto' | 'confirm' = 'auto'): void {
  expect(composer()).toMatchObject({
    value: '',
    skills: [],
    model: 'sample-provider::default-model',
    modeId: 'normal',
    approvalMode,
    workspacePath,
    environmentIds: [],
    images: [],
    files: [],
  });
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('File', dom.window.File);
  vi.stubGlobal('FileReader', dom.window.FileReader);
  vi.stubGlobal('Blob', dom.window.Blob);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  clearAllComposerDrafts();
  rows.sessions = [];
  rows.history = [];
  useUIStore.setState({ consoleSelection: null, expandedWorkspaceGroups: [] });
  useComposerDraftStore.setState({ defaults: DEFAULT_COMPOSER_SETTINGS });
  selectFolder.mockReset().mockResolvedValue(['/tmp/sample-workspace']);
  onStart.mockReset().mockResolvedValue({ kind: 'failed' });
  runtime.agentCommands.setApprovalMode.mockReset().mockResolvedValue({ ok: true });
  runtime.agentCommands.setSubagentApprovalMode.mockReset().mockResolvedValue({ ok: true });
  runtime.agentCommands.respondToApproval.mockReset().mockResolvedValue({ ok: true });
  runtime.agentCommands.start.mockReset().mockResolvedValue({ ok: true, value: 'agent-a' });
  Object.defineProperty(window, 'piskie', {
    configurable: true,
    value: {
      desktop: { files: { select: selectFolder } },
      capabilities: { mcp: { prewarm: vi.fn().mockResolvedValue(null) } },
    },
  });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, {
    createObjectURL: vi.fn().mockReturnValue('blob:sample-image'),
    revokeObjectURL,
  }));
  useInferenceStore.setState({
    selections: { schemaVersion: 1, revision: 0, ai: { providerId: 'sample-provider', modelId: 'default-model' } },
  });
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearAllComposerDrafts();
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('workspace navigation reveal', () => {
  it('reveals a newly selected session once its row arrives, and respects later manual collapse', async () => {
    act(() => shellRef.current!.selectSession('session-a'));
    rows.sessions = [{
      agentId: 'session-a', title: 'Sample session', workspace: '/sample/alpha',
      phase: 'executing', status: 'running', createdAt: '2026-01-01T00:00:00Z',
      workerCount: 0, model: 'sample-provider::sample-model', interrupted: false,
      activity: { kind: 'idle', text: rawText('Sample activity') },
    }];
    await act(async () => root.render(React.createElement(Harness)));
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['/sample/alpha']);
    act(() => useUIStore.getState().toggleWorkspaceGroup('/sample/alpha'));
    rows.sessions = rows.sessions.map((row) => ({ ...row, workerCount: 1 }));
    await act(async () => root.render(React.createElement(Harness)));
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual([]);
    act(() => shellRef.current!.selectSession('session-a'));
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['/sample/alpha']);
    act(() => useUIStore.getState().toggleWorkspaceGroup('/sample/alpha'));
    await remount();
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual([]);
  });

  it('reveals history and new-session workspaces through explicit actions', () => {
    const record: HistoryRow = {
      agentId: 'history-a', title: 'Sample history', taskDescription: 'Sample history',
      workspace: '/sample/beta', agentSpec: 'system-chat', running: false,
      lastActiveAt: '2026-01-01T00:00:00Z',
    };
    act(() => shellRef.current!.openHistory(record));
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['/sample/beta']);
    act(() => shellRef.current!.newSession());
    expect(useUIStore.getState().expandedWorkspaceGroups).toEqual(['/sample/beta', '']);
  });
});

describe('welcome composer lifecycle', () => {
  it('restores all selections, text and attachments after leaving and returning', async () => {
    await fillDraft();
    act(() => useInferenceStore.setState({
      selections: { schemaVersion: 1, revision: 1, ai: { providerId: 'sample-provider', modelId: 'updated-default' } },
    }));
    await remount();

    expect(composer()).toMatchObject({
      value: 'Inspect the sample',
      skills: ['sample-guide', 'sample-table'],
      model: 'sample-provider::chosen-model',
      modeId: 'plan',
      approvalMode: 'auto',
      workspacePath: '/tmp/sample-workspace',
      environmentIds: ['browser-a', 'browser-b'],
      images: [{ status: 'ready' }],
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('follows the configured model until explicitly selected and uses it again for a new draft', async () => {
    act(() => useInferenceStore.setState({
      selections: { schemaVersion: 1, revision: 1, ai: { providerId: 'sample-provider', modelId: 'updated-default' } },
    }));
    expect(composer().model).toBe('sample-provider::updated-default');
    act(() => {
      composer().onModelChange('sample-provider::chosen-model');
      composer().onModeChange('browser-skill');
    });
    await remount();
    expect(composer()).toMatchObject({ model: 'sample-provider::chosen-model', modeId: 'browser-skill' });
    act(() => shellRef.current!.newSession());
    expect(composer()).toMatchObject({ model: 'sample-provider::updated-default', modeId: 'normal' });
  });

  it('remembers manual approval selection for new drafts until changed back', async () => {
    expectFresh(undefined, 'confirm');
    act(() => composer().onApprovalModeChange('auto'));
    await remount();
    act(() => shellRef.current!.newSession());
    expectFresh();
    act(() => composer().onApprovalModeChange('confirm'));
    act(() => shellRef.current!.newSessionIn('/tmp/group-workspace'));
    expectFresh('/tmp/group-workspace', 'confirm');
  });

  it.each(['main', 'worker'] as const)('remembers a manual selection in a %s composer for quick chats and templates', async (target) => {
    const settings = target === 'main' ? settingsRef : workerSettingsRef;
    await act(async () => { await settings.current!.onApprovalModeChange('auto'); });
    act(() => shellRef.current!.newSession());
    expectFresh();
    await act(async () => { await startRef.current!.startQuickChat('Sample task'); });
    expect(runtime.agentCommands.start).toHaveBeenLastCalledWith(expect.objectContaining({ approvalMode: 'auto' }));
    await act(async () => {
      await startRef.current!.startTaskDefinition({
        definitionId: 'definition-a', name: 'Sample template', description: '',
        purpose: 'general', promptTemplate: 'Sample task', defaultModeId: 'normal',
        defaultApprovalMode: 'confirm', createdAt: '2026-01-01T00:00:00Z',
      });
    });
    expect(runtime.agentCommands.start).toHaveBeenLastCalledWith(expect.objectContaining({
      definitionId: 'definition-a', approvalMode: 'auto',
    }));
  });

  it('does not change new-session defaults when auto is chosen in a tool approval', async () => {
    await act(async () => {
      await actionsRef.current!.decide({ agentId: 'agent-a' }, {
        kind: 'allow', callId: 'tool-a', changeToAuto: true,
      });
    });
    expect(runtime.agentCommands.respondToApproval).toHaveBeenCalledWith('agent-a', undefined, {
      callId: 'tool-a', decision: 'allow', changeToAuto: true,
    });
    act(() => shellRef.current!.newSession());
    expectFresh(undefined, 'confirm');
  });

  it('keeps the previous default when the session rejects a mode change', async () => {
    runtime.agentCommands.setApprovalMode.mockResolvedValue({ ok: false, error: 'Sample failure' });
    await act(async () => { await settingsRef.current!.onApprovalModeChange('auto'); });
    act(() => shellRef.current!.newSession());
    expectFresh(undefined, 'confirm');
  });

  it('retains selections after removing all content, including an explicit default workspace', async () => {
    await fillDraft();
    act(() => {
      composer().onChange('');
      composer().onRemoveAttachment(composer().images[0]!.id);
      composer().onUseDefaultWorkspace();
    });
    await remount();

    expect(composer()).toMatchObject({
      value: '', images: [], workspacePath: undefined,
      model: 'sample-provider::chosen-model', modeId: 'plan', approvalMode: 'auto',
      environmentIds: ['browser-a', 'browser-b'],
    });
  });

  it('starts fresh on every welcome plus action, preserves other targets and releases image bytes', async () => {
    const agentKey = composerDraftKey('agent-a');
    useComposerDraftStore.getState().setDraft(agentKey, 'Another draft');
    await fillDraft();
    act(() => shellRef.current!.newSession());
    expectFresh();
    expect(composerImageUsage().originalBytes).toBe(0);
    expect(useComposerDraftStore.getState().drafts[agentKey]?.text).toBe('Another draft');

    act(() => composer().onChange('A second draft'));
    act(() => shellRef.current!.newSession());
    expectFresh();
  });

  it('uses a workspace group only for that new draft and resets on repeated new actions', async () => {
    await fillDraft();
    act(() => shellRef.current!.newSessionIn('/tmp/group-workspace'));
    expectFresh('/tmp/group-workspace');
    act(() => composer().onChange('Group draft'));
    act(() => shellRef.current!.newSessionIn('/tmp/group-workspace'));
    expectFresh('/tmp/group-workspace');

    await act(async () => composer().onSelectWorkspace());
    await remount();
    expect(composer().workspacePath).toBe('/tmp/sample-workspace');
    act(() => shellRef.current!.newSession());
    expectFresh();
  });

  it('submits restored options, retains the draft on failure, and resets it on success', async () => {
    await fillDraft();
    await remount();
    await act(async () => { await composer().onSubmit(); });
    expect(onStart).toHaveBeenCalledWith('Inspect the sample', expect.objectContaining({
      model: 'sample-provider::chosen-model', modeId: 'plan', approvalMode: 'auto',
      workspace: '/tmp/sample-workspace', environmentIds: ['browser-a', 'browser-b'],
      images: [{ data: Buffer.from(pngBytes()).toString('base64'), media_type: 'image/png' }],
      skills: ['sample-guide', 'sample-table'],
    }));
    expect(composer().value).toBe('Inspect the sample');
    expect(composer().images).toHaveLength(1);
    expect(composer().skills).toEqual(['sample-guide', 'sample-table']);

    onStart.mockResolvedValue({ kind: 'started', agentId: 'agent-a' });
    await act(async () => { await composer().onSubmit(); });
    expectFresh();
  });

  it('does not apply a late folder selection or successful submission to a new draft', async () => {
    let resolveFolder!: (paths: string[]) => void;
    let resolveStart!: (outcome: StartOutcome) => void;
    selectFolder.mockReturnValue(new Promise<string[]>((resolve) => { resolveFolder = resolve; }));
    onStart.mockReturnValue(new Promise<StartOutcome>((resolve) => { resolveStart = resolve; }));
    act(() => composer().onChange('Old draft'));
    await act(async () => {
      composer().onSelectWorkspace();
      composer().onSubmit();
    });
    act(() => shellRef.current!.newSessionIn('/tmp/new-workspace'));
    act(() => composer().onChange('New draft'));
    await act(async () => {
      resolveFolder(['/tmp/old-workspace']);
      resolveStart({ kind: 'started', agentId: 'agent-a' });
    });

    expect(composer()).toMatchObject({ value: 'New draft', workspacePath: '/tmp/new-workspace' });
  });
});


describe('selected skill send boundaries', () => {
  it('retains newer welcome edits when an earlier startup succeeds', async () => {
    let accepted!: (outcome: StartOutcome) => void;
    onStart.mockReturnValueOnce(new Promise<StartOutcome>((resolve) => { accepted = resolve; }));
    act(() => composer().onSkillsChange(['sample-guide']));
    await act(async () => { composer().onSubmit(); });
    act(() => composer().onChange('Next example'));
    await act(async () => accepted({ kind: 'started', agentId: 'session-example' }));
    expect(composer()).toMatchObject({ value: 'Next example', skills: ['sample-guide'] });
  });

  it('starts with only selected skills and retains the welcome draft until accepted', async () => {
    act(() => composer().onSkillsChange(['sample-guide']));
    await remount();
    await act(async () => { await composer().onSubmit(); });
    expect(onStart).toHaveBeenLastCalledWith('', expect.objectContaining({ skills: ['sample-guide'] }));
    expect(composer().skills).toEqual(['sample-guide']);
    await act(async () => { await startRef.current!.startQuickChat('', { skills: ['sample-guide'], workspace: '/workspace/sample' }); });
    expect(runtime.agentCommands.start).toHaveBeenLastCalledWith(expect.objectContaining({
      input: '', skills: ['sample-guide'], workspace: '/workspace/sample',
    }));
    onStart.mockResolvedValue({ kind: 'started', agentId: 'session-example' });
    await act(async () => { await composer().onSubmit(); });
    expect(composer().skills).toEqual([]);
  });

  it('clears only skill choices when the welcome workspace changes', async () => {
    await fillDraft();
    act(() => composer().onUseDefaultWorkspace());
    expect(composer().skills).toEqual([]);
    expect(composer().value).toBe('Inspect the sample');
    expect(composer().images).toHaveLength(1);
    act(() => composer().onSkillsChange(['sample-guide']));
    act(() => composer().onUseDefaultWorkspace());
    expect(composer().skills).toEqual(['sample-guide']);
    await act(async () => composer().onSelectWorkspace());
    expect(composer().skills).toEqual([]);
  });

  it.each(['main', 'worker'] as const)('preserves selected skills in the %s inject request alongside attachments', async (kind) => {
    const target = { agentId: 'session-example', ...(kind === 'worker' ? { workerId: 'worker-example' } : {}) };
    const command = kind === 'worker' ? runtime.agentCommands.injectSubagent : runtime.agentCommands.inject;
    command.mockResolvedValue({ ok: true });
    await act(async () => {
      await actionsRef.current!.send(target, {
        text: '', skills: ['sample-guide', 'sample-table'],
        files: [{ name: 'sample.txt', path: '/workspace/sample.txt' }],
        images: [{ data: 'c2FtcGxl', media_type: 'image/png' }],
      });
    });
    const event = command.mock.calls.at(-1)!.at(-1);
    expect(event).toMatchObject({ source: 'user', skills: ['sample-guide', 'sample-table'], images: [{ data: 'c2FtcGxl', media_type: 'image/png' }] });
    expect(event.content).toContain('/workspace/sample.txt');
    await act(async () => { await actionsRef.current!.send(target, { text: '/sample-guide' }); });
    expect(command.mock.calls.at(-1)!.at(-1)).toMatchObject({ content: '/sample-guide', skills: undefined });
  });
});

describe('Worker instance inference settings', () => {
  it('writes concrete reasoning only to the Worker without touching model defaults', async () => {
    const defaults = vi.spyOn(useInferenceStore.getState(), 'updateModelReasoningDefault');
    runtime.agentCommands.setSubagentReasoning.mockResolvedValue({ ok: true });
    await act(async () => { await workerSettingsRef.current!.onReasoningChange({ kind: 'effort', effort: 'high' }); });
    expect(runtime.agentCommands.setSubagentReasoning).toHaveBeenCalledWith('agent-a', 'worker-a', { kind: 'effort', effort: 'high' });
    expect(defaults).not.toHaveBeenCalled();
    runtime.agentCommands.setSubagentModel.mockResolvedValue({ ok: false, error: 'Unavailable model' });
    await act(async () => { await workerSettingsRef.current!.onModelChange('gone::model'); });
    expect(runtime.agentCommands.setSubagentModel).toHaveBeenCalledWith('agent-a', 'worker-a', 'gone::model');
    defaults.mockRestore();
  });
});
