import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInferenceStore } from '../../../../../store/inferenceStore';
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
import type { WelcomeComposerProps } from '../WelcomeComposer';

const { renderComposer, runtime, control, preview } = vi.hoisted(() => ({
  renderComposer: vi.fn(),
  runtime: {
    agentRuns: { refresh: vi.fn().mockResolvedValue(undefined) },
    agentCommands: {
      setApprovalMode: vi.fn(), setSubagentApprovalMode: vi.fn(),
      respondToApproval: vi.fn(), start: vi.fn(),
    },
  },
  control: { agentsById: {} },
  preview: { state: null },
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
  useSessionRows: () => [],
  useHistoryRows: () => [],
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
  act(() => composer().onPaste({
    clipboardData: {
      items: [{
        kind: 'file',
        getAsFile: () => new File(['image-bytes'], 'sample.png', { type: 'image/png' }),
      }],
      getData: () => '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent));
}

function expectFresh(workspacePath?: string, approvalMode: 'auto' | 'confirm' = 'auto'): void {
  expect(composer()).toMatchObject({
    value: '',
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

describe('welcome composer lifecycle', () => {
  it('restores all selections, text and attachments after leaving and returning', async () => {
    await fillDraft();
    act(() => useInferenceStore.setState({
      selections: { schemaVersion: 1, revision: 1, ai: { providerId: 'sample-provider', modelId: 'updated-default' } },
    }));
    await remount();

    expect(composer()).toMatchObject({
      value: 'Inspect the sample',
      model: 'sample-provider::chosen-model',
      modeId: 'plan',
      approvalMode: 'auto',
      workspacePath: '/tmp/sample-workspace',
      environmentIds: ['browser-a', 'browser-b'],
      images: [{ previewUrl: 'blob:sample-image' }],
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

  it('starts fresh on every plus action, preserves other targets and releases previews', async () => {
    const agentKey = composerDraftKey('agent-a');
    useComposerDraftStore.getState().setDraft(agentKey, 'Another draft');
    await fillDraft();
    act(() => shellRef.current!.newSession());
    expectFresh();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sample-image');
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
      images: [{ data: 'aW1hZ2UtYnl0ZXM=', media_type: 'image/png' }],
    }));
    expect(composer().value).toBe('Inspect the sample');
    expect(composer().images).toHaveLength(1);

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
