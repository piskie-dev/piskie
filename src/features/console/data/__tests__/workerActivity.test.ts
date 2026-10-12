import i18n from 'i18next';
import { beforeEach, describe, expect, it } from 'vitest';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import { isWorkerUnfinished, latestWorkerNotification, resolveWorkerActivity } from '../workerActivity';
import type { WorkerVM } from '../vm';
import { projectLiveNodes } from '@/domains/transcript/live-generation';

const worker = (patch: Partial<WorkerVM> = {}): WorkerVM => ({
  id: 'sample-child', mainAgentId: 'sample-parent', subject: 'Sample task', type: 'browser-worker',
  phase: 'executing', status: 'running', interrupted: false, canPause: true,
  model: 'sample-model', reasoningOverride: { kind: 'provider-default' }, approvalMode: 'auto', conversationLength: 1,
  runMetrics: {} as WorkerVM['runMetrics'], pendingEvents: [], browserReady: true,
  browserId: 'sample-browser', imageNodeIds: [], taskState: { inputAt: 1000 }, ...patch,
});
const parent = (type = 'completed', at = 2000): TranscriptNode[] => projectConversationNodes([{
  t: 'msg', ts: at + 1000, id: `sample-notification-${type}-${at}`, role: 'user', subtype: 'subagent_notification',
  content: `<subagent_event id="sample-child" type="${type}" ts="${new Date(at).toISOString()}">Sample result</subagent_event>`,
}]);
const followup = (ok: boolean, callTs = 4000, resultTs = 4100): TranscriptNode[] => projectConversationNodes([{
  t: 'msg', ts: callTs, id: 'sample-followup', role: 'assistant', content: [{
    type: 'tool_use', id: 'sample-send', name: 'send_event', input: { targetId: 'sample-child', message: 'Inspect another sample.' },
  }],
}, { t: 'tool', ts: resultTs, toolUseId: 'sample-send', ok, result: [{ type: 'text', text: 'Sample delivery result' }] }]);
const child = (): TranscriptNode[] => projectConversationNodes([{
  t: 'msg', ts: 1200, id: 'sample-progress', role: 'assistant', content: [
    { type: 'thinking', thinking: 'Private reasoning sample' },
    { type: 'text', text: 'Inspecting the sample page.' },
    { type: 'tool_use', id: 'sample-call', name: 'shell', input: { command: 'sample-command', description: 'Read sample records' } },
  ],
}]);
const activity = (runtime: WorkerVM | null, nodes: readonly TranscriptNode[] = [], notices: readonly TranscriptNode[] = []) =>
  resolveWorkerActivity(runtime, nodes, notices, 'sample-child', i18n.t.bind(i18n));

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
describe('worker current activity', () => {
  it.each([undefined, true, false])('uses the last shell line through running, completion and failure (ok: %s)', (ok) => {
    const entries = [{
      t: 'msg' as const, ts: 1200, id: 'sample-call-message', role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'Inspecting the sample page.' },
        { type: 'tool_use' as const, id: 'sample-call', name: 'shell', input: { command: 'sample-command', description: 'Read sample records' } },
      ],
    }, ...(ok === undefined ? [] : [{
      t: 'tool' as const, ts: 1500, toolUseId: 'sample-call', ok, result: [{ type: 'text' as const, text: 'Sample tool result' }],
    }])];
    expect(activity(worker(), projectConversationNodes(entries)).text)
      .toBe(`Run command · ${ok === false ? 'Sample tool result' : 'Read sample records'}`);
  });
  it('uses later assistant content even while an earlier tool is running', () => {
    const nodes = [...child(), ...projectConversationNodes([{
      t: 'msg', ts: 1500, id: 'sample-latest', role: 'assistant', content: 'Latest sample\n\nprogress.',
    }])];
    expect(activity(worker(), nodes).text).toBe('Latest sample progress.');
  });
  it('keeps source order when the latest completed tool has an earlier timestamp', () => {
    const nodes = [...child(), ...projectConversationNodes([{
      t: 'msg', ts: 500, id: 'sample-second-call', role: 'assistant', content: [{
        type: 'tool_use', id: 'sample-generic', name: 'example_tool', input: {},
      }],
    }, { t: 'tool', ts: 800, toolUseId: 'sample-generic', ok: true, result: [{ type: 'text', text: 'Sample response' }] }])];
    expect(activity(worker(), nodes).text).toBe('example_tool · Sample response');
  });
  it('keeps the last visible content when the input time changes', () => {
    expect(activity(worker({ taskState: { inputAt: 4000 } }), child(), parent()).text).toBe('Run command · Read sample records');
    expect(activity(worker({ taskState: { inputAt: 4000 } }), child(), parent()).outcome).toBeUndefined();
  });
  it.each(['think', 'text'] as const)('includes the last live %s node with timestamp zero', (kind) => {
    const live = projectLiveNodes('sample-child', {
      phase: 'streaming', requestId: 'sample-request', runId: 'sample-run', attempt: 1, lastSequence: 1,
      parts: [{ kind, markdown: 'Earlier line\nLatest sample line\n' }],
    });
    expect(live[0]?.ts).toBe(0);
    expect(activity(worker({ taskState: { inputAt: 4000 } }), [...child(), ...live]).text)
      .toBe(kind === 'think' ? 'Thinking · Latest sample line' : 'Earlier line Latest sample line');
  });
  it('uses the persisted reasoning disclosure preview when reasoning is last', () => {
    expect(activity(worker(), child().filter((node) => node.kind === 'think')).text).toBe('Think · Private reasoning sample');
  });
  it('uses projected visibility for suppressed tools, redacted thinking and empty user input', () => {
    const hidden = projectConversationNodes([{
      t: 'msg', ts: 1800, id: 'sample-hidden', role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'sample-redacted' },
        { type: 'tool_use', id: 'sample-task', name: 'task', input: { action: 'update' } },
      ],
    }, { t: 'tool', ts: 1900, toolUseId: 'sample-task', ok: true, result: [{ type: 'text', text: 'Sample result' }] }, {
      t: 'msg', ts: 2000, id: 'sample-empty-input', role: 'user', subtype: 'user_input', content: '',
    }]);
    expect(hidden.map((node) => node.id)).toEqual(['sample-empty-input']);
    expect(activity(worker(), [...child(), ...hidden]).text).toBe('Run command · Read sample records');
    expect(activity(worker(), hidden).text).toBe('');
  });
  it('includes the assignment card, plan card and child notices in visible order', () => {
    const assignment = projectConversationNodes([{
      t: 'msg', ts: 1000, id: 'sample-assignment', role: 'user', subtype: 'assignment',
      content: '<assignment><prompt>Inspect a sample.</prompt></assignment>',
    }]);
    expect(activity(worker(), assignment).text).toBe('Assignment · Inspect a sample.');
    const plan = projectConversationNodes([{
      t: 'msg', ts: 1500, id: 'sample-plan-message', role: 'assistant', content: [{
        type: 'tool_use', id: 'sample-plan', name: 'plan', input: { action: 'create', taskSummary: 'Sample plan', planDocument: 'Review the sample.' },
      }],
    }]);
    expect(activity(worker(), [...assignment, ...plan]).text).toBe('Execution plan · Sample plan');
    expect(activity(worker(), [...assignment, ...plan, ...parent('message')]).text).toBe('Message from worker · Sample result');
  });
  it('keeps an empty preview without visible child content or a created child', () => {
    expect(activity(worker()).text).toBe('');
    expect(activity(null)).toEqual({ text: '', unfinished: false });
    expect(activity(null, [], parent())).toEqual({ text: '', outcome: 'completed', unfinished: false });
  });
  it.each(['completed', 'failed', 'user_stopped'] as const)('reports %s independently of an available browser', (type) => {
    const runtime = worker({ taskState: { inputAt: 1000, notification: { type, at: 2000 } } });
    expect(activity(runtime, child()).text).toBe('Run command · Read sample records');
    expect(activity(runtime, child()).outcome).toBe(type);
    expect(activity(runtime, child()).unfinished).toBe(false);
    expect(isWorkerUnfinished(runtime)).toBe(false);
    expect(activity(null, [], parent(type)).outcome).toBe(type);
  });
  it.each(['waiting', 'interrupted', 'stopping', 'thinking', 'running'] as const)('keeps %s status separate from the last content', (status) => {
    expect(activity(worker({ status }), child())).toMatchObject({ text: 'Run command · Read sample records', unfinished: true });
    expect(isWorkerUnfinished(worker({ status }))).toBe(true);
  });
  it('keeps approval, questions, request failures and parent notices separate from content', () => {
    const patches: Partial<WorkerVM>[] = [
      { pendingToolCall: { description: 'Sample approval' } as WorkerVM['pendingToolCall'] },
      { askUser: { id: 'sample-question', items: [] } },
      { request: { failed: true, retrying: false, backoff: false, attempt: 1, maxAttempts: 2 } },
      { request: { failed: false, retrying: true, backoff: true, attempt: 2, maxAttempts: 2 } },
      ...(['need_user_action', 'message'] as const).map((type) => ({ taskState: { inputAt: 4000, notification: { type, at: 5000 } } })),
    ];
    for (const patch of patches) expect(activity(worker(patch), child(), parent()).text).toBe('Run command · Read sample records');
  });
  it('clears a historical terminal when the parent sends a real follow-up', () => {
    const current = worker({ taskState: undefined, status: 'thinking' });
    expect(activity(current, [], [...parent(), ...followup(true)]).outcome).toBeUndefined();
  });
  it.each(['completed', 'failed', 'user_stopped'] as const)('retains historical %s through later progress and user-action notices', (type) => {
    const notices = [...parent(type), ...parent('message', 3000), ...parent('need_user_action', 3500)];
    expect(activity(null, [], notices)).toMatchObject({ outcome: type, unfinished: false });
    expect(latestWorkerNotification(notices, 'sample-child')).toEqual({ type, at: 2000 });
    expect(latestWorkerNotification([...notices, ...followup(false)], 'sample-child')).toEqual({ type, at: 2000 });
    expect(latestWorkerNotification([...notices, ...parent('failed', 3800)], 'sample-child')).toEqual({ type: 'failed', at: 3800 });
    expect(latestWorkerNotification([...notices, ...followup(true)], 'sample-child')).toBeUndefined();
    expect(latestWorkerNotification([...notices, ...followup(true), ...parent('message', 4500)], 'sample-child'))
      .toEqual({ type: 'message', at: 4500 });
  });
  it('keeps a newer terminal when the follow-up result is recorded after it and ignores older notices in either projection order', () => {
    const terminal = parent('completed', 3000);
    for (const nodes of [[...followup(true, 2500, 4000), ...terminal], [...terminal, ...followup(true, 2500, 4000)]]) {
      expect(latestWorkerNotification(nodes, 'sample-child')).toEqual({ type: 'completed', at: 3000 });
    }
    for (const nodes of [[...followup(true, 2500, 4000), ...parent()], [...parent(), ...followup(true, 2500, 4000)]]) {
      expect(latestWorkerNotification(nodes, 'sample-child')).toBeUndefined();
    }
    expect(latestWorkerNotification([...followup(false, 2500, 4000), ...parent()], 'sample-child'))
      .toEqual({ type: 'completed', at: 2000 });
    expect(latestWorkerNotification([...followup(true, 2500, 4000), ...terminal, ...parent('user_stopped', 4500)], 'sample-child'))
      .toEqual({ type: 'user_stopped', at: 4500 });
  });
  it('keeps terminal precedence when historical notices are projected out of delivery order', () => {
    expect(latestWorkerNotification([...parent('message', 3000), ...parent('completed'), ...parent('need_user_action', 3500)], 'sample-child'))
      .toEqual({ type: 'completed', at: 2000 });
  });
});
