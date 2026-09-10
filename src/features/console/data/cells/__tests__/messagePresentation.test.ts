/**
 * user 消息归属判定。用例逐条对应**代码里当前活着的注入点**（不是历史会话数据——
 * `<wakeup>` 那类形状随 `wait` 工具一起删了，拿它当依据会得出错误结论）。
 *
 * 注入点只记文件与符号，不记行号：本文件写就期间 `closure_check` 的注入行号就从 382
 * 漂到了 365，另一个改动同时删掉了整个冲程预算机制。行号引用会静默腐坏。
 *
 * | # | 注入点 | subtype | 文本形状 |
 * |---|---|---|---|
 * | 1 | `director.role.ts` 初始任务 | `system_task` | 裸文本 |
 * | 2 | `worker.role.ts` Assignment | `assignment` | assignment 信封 |
 * | 3 | `agent-runtime.ts` 外部事件 source=user | `user_input` | 裸文本 |
 * | 4 | `agent-runtime.ts` 外部事件 source≠user | `system_event` | `<agent_input>` |
 * | 5 | `subagent.module.ts` 子流程通知 | `subagent_notification` | `<subagent_event>` |
 * | 6 | `subagent.module.ts` requestClosureCheck | `system_event` | `<agent_input source="system">` 内的 `<closure_check>` |
 * | 7 | `agent.service.ts` 恢复通知 | `system_event` | **裸文本** |
 * | 8 | `settler.ts` notify | `system_event` | `<task-notification>` |
 * | 9 | `subagent.module.ts` notifyUserInterruptedWorkers | `system_event` | `<agent_input source="system">` 内的 `<worker_interrupted>` |
 *
 * #7 是本设计的要害：**一句裸中文，没有信封**，与用户手打的消息在文本层面无法区分，
 * 所以判据只能是 subtype。它和 #8 此前都被画成用户气泡。
 */

import { describe, expect, it } from 'vitest';

import type { MsgEntry } from '../../../../../../shared/types/agent-control';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { messageText, rawText } from '../../presentationText';
import { presentUserMessage } from '../messagePresentation';

describe('按 subtype 定归属', () => {
  it('#3 用户输入 → 气泡', () => {
    expect(presentUserMessage('user_input', '帮我改一下地图')).toEqual({
      as: 'user',
      origin: 'user',
      text: '帮我改一下地图',
    });
  });

  it('#1 顶层任务描述 → 气泡（那就是用户派的活）', () => {
    const presented = presentUserMessage('system_task', '重构这个游戏 现在地图设计的不合理');
    expect(presented.as).toBe('user');
    expect(presented).toMatchObject({ origin: 'user' });
  });

  it('#2 Assignment → 气泡 · assignment 色，正文原样交给 buildUserNode 解包', () => {
    const raw = '<assignment>\n<subject>实现地形</subject>\n</assignment>';
    expect(presentUserMessage('assignment', raw)).toEqual({
      as: 'user',
      origin: 'assignment',
      text: raw,
    });
  });

  it('#7 会话恢复通知（裸文本，无信封）→ 事件行，不是用户发言', () => {
    const presented = presentUserMessage(
      'system_event',
      '会话已恢复。以下 Worker 已终止，不要向这些 ID 发送消息：\n- local-1 (Assignment: 建地形) — 已因中断终止',
    );
    expect(presented.as).toBe('notice');
  });

  it('subagent 通知的裸文本形态也落事件行', () => {
    expect(presentUserMessage('subagent_notification', '子流程已完成').as).toBe('notice');
  });

});

describe('信封覆盖', () => {
  it('#4 agent_input → 升级回消息气泡；source=parent 用父级色', () => {
    expect(
      presentUserMessage('system_event', '<agent_input source="parent" ts="t">父级说的话</agent_input>'),
    ).toEqual({ as: 'user', origin: 'parent', text: '父级说的话' });

    expect(
      presentUserMessage('system_event', '<agent_input source="wecom" ts="t">群里的消息</agent_input>'),
    ).toEqual({ as: 'user', origin: 'user', text: '群里的消息' });
  });

  it('父流程 ATA 信封只展示可读消息，不暴露传输字段', () => {
    const inlineEnvelope = JSON.stringify({
      storage: 'inline',
      type: 'message',
      data: { type: 'message', message: '请继续检查构建结果。' },
      originalSize: 12,
    });
    expect(presentUserMessage(
      'system_event',
      `<agent_input source="parent" ts="t">${inlineEnvelope}</agent_input>`,
    )).toEqual({ as: 'user', origin: 'parent', text: '请继续检查构建结果。' });

    const fileEnvelope = JSON.stringify({
      storage: 'file',
      type: 'message',
      summary: '请读取完整检查说明。',
      filePath: '/tmp/flow-event-1.jsonl',
      originalSize: 1200,
    });
    expect(presentUserMessage(
      'system_event',
      `<agent_input source="parent" ts="t">${fileEnvelope}</agent_input>`,
    )).toEqual({ as: 'user', origin: 'parent', text: '请读取完整检查说明。' });
  });

  it('#5 subagent_event → 事件行，source 取 id', () => {
    expect(presentUserMessage(
      'subagent_notification',
      '<subagent_event id="local-1" type="completed" ts="t">干完了</subagent_event>',
    )).toMatchObject({
      as: 'notice',
      source: 'local-1',
      text: '干完了',
      eventType: 'completed',
      titleKey: 'transcript.notice.workerCompleted',
      tone: 'neutral',
    });
  });

  it('文件型子流程事件拆出摘要和详情文件，不暴露 XML 标签', () => {
    const presented = presentUserMessage(
      'subagent_notification',
      [
        '<subagent_event id="worker-1" type="failed" ts="t">',
        '<summary>构建检查失败，已保留诊断现场。</summary>',
        '<detail path="/tmp/flow-event-detail.md"/>（完整内容可用 read 读取）',
        '</subagent_event>',
      ].join('\n'),
    );

    expect(presented).toMatchObject({
      as: 'notice',
      source: 'worker-1',
      text: '构建检查失败，已保留诊断现场。',
      summary: '构建检查失败，已保留诊断现场。',
      detailFile: '/tmp/flow-event-detail.md',
      eventType: 'failed',
      titleKey: 'transcript.notice.workerFailed',
      tone: 'danger',
    });
  });

  it('#6 closure_check → 事件行', () => {
    const presented = presentUserMessage('system_event', '<closure_check ts="t"/>\n请选择收尾方式');
    expect(presented).toMatchObject({
      as: 'notice',
      source: 'closure_check',
      text: '请选择收尾方式',
      titleKey: 'transcript.systemEvent.closureCheck',
    });
  });

  it('#8 task-notification → 事件行，折叠态用 <summary> 而非 XML 首行', () => {
    const raw = [
      '<task-notification>',
      '<task-id>0d032582</task-id>',
      '<output-file>/tmp/a.log</output-file>',
      '<status>failed</status>',
      '<summary>后台任务失败（exit 128），用时 542980ms。</summary>',
      '<tail>npm warn …</tail>',
      '</task-notification>',
    ].join('\n');

    const presented = presentUserMessage('system_event', raw);
    expect(presented.as).toBe('notice');
    expect(presented).toMatchObject({
      source: 'task_notification',
      summary: '后台任务失败（exit 128），用时 542980ms。',
    });
  });

  it('未登记的信封不改变默认归属——不会伪装成用户发言', () => {
    expect(presentUserMessage('system_event', '<future-envelope>将来某个新事件</future-envelope>').as)
      .toBe('notice');
  });

  it('结构化 context_overflow → 失败通知；不通过 provider 英文文案猜类型', () => {
    const providerMessage = 'Your input exceeds the context window of this model.\n'
      + 'Please adjust your input and try again.';
    const presented = presentUserMessage(
      'subagent_notification',
      `<subagent_event id="worker-1" type="failed" ts="t" error_type="context_overflow" origin="runtime" provider="relay" model="test-model" request_id="req-1">\n${providerMessage}\n</subagent_event>`,
    );

    expect(presented).toMatchObject({
      as: 'notice',
      source: 'worker-1',
      text: providerMessage,
      titleKey: 'transcript.notice.workerFailed',
      tone: 'danger',
      defaultExpanded: false,
      eventType: 'failed',
      errorType: 'context_overflow',
      metadata: [
        messageText('transcript.meta.origin', { value: rawText('runtime') }),
        messageText('transcript.meta.provider', { value: rawText('relay') }),
        messageText('transcript.meta.model', { value: rawText('test-model') }),
        messageText('transcript.meta.requestId', { value: rawText('req-1') }),
      ],
    });
    expect(presented.as === 'notice' && presented.guidance)
      .toEqual(messageText('transcript.guidance.contextOverflow'));
  });

});

describe('system injection presentation', () => {
  it.each(['system', 'module', 'browser', 'subagent'])('keeps %s input in a system event row', (source) => {
    expect(presentUserMessage('system_event', `<agent_input source="${source}" ts="t">Sample automatic notice.</agent_input>`))
      .toMatchObject({ as: 'notice', source, text: 'Sample automatic notice.', titleKey: 'transcript.systemEvent.message' });
  });

  it.each(['api', 'webhook'])('preserves externally submitted %s messages', (source) => {
    expect(presentUserMessage('system_event', `<agent_input source="${source}" ts="t">Sample request.</agent_input>`))
      .toEqual({ as: 'user', origin: 'user', text: 'Sample request.' });
  });

  it.each(['user_input', 'system_task'] as const)('preserves literal tags in %s text', (subtype) => {
    const text = '<worker_interrupted>Sample quoted markup.</worker_interrupted>';
    expect(presentUserMessage(subtype, text)).toEqual({ as: 'user', origin: 'user', text });
  });

  it('projects the nested interruption envelope as a readable system notice', () => {
    const body = 'The sample worker was interrupted. More work may be assigned later.';
    const [cell] = projectConversationNodes([{
      t: 'msg', ts: 1, id: 'sample-notice', role: 'user', subtype: 'system_event',
      content: `<agent_input source="system" ts="t">\n<worker_interrupted>\n${body}\n</worker_interrupted>\n</agent_input>`,
    }]);
    expect(cell).toMatchObject({
      kind: 'notice', source: 'worker_interrupted', titleKey: 'transcript.systemEvent.workerInterrupted',
      tone: 'warning', text: body, defaultExpanded: false,
      summary: messageText('transcript.systemEvent.workerInterruptedSummary'),
    });
    expect(cell?.detail?.().sections).toEqual([{ value: body, format: 'text' }]);
  });

  it('recognizes the paired closure check inside a system input envelope', () => {
    expect(presentUserMessage('system_event', '<agent_input source="system" ts="t">\n<closure_check>\nCheck the sample task.\n</closure_check>\n</agent_input>'))
      .toMatchObject({
        as: 'notice', source: 'closure_check', text: 'Check the sample task.',
        summary: messageText('transcript.systemEvent.closureCheckSummary'),
        titleKey: 'transcript.systemEvent.closureCheck', tone: 'muted',
      });
  });

  it('presents system reminders without their transport wrapper', () => {
    expect(presentUserMessage('system_event', '<system-reminder>Review the sample result.</system-reminder>'))
      .toMatchObject({ as: 'notice', source: 'system_reminder', text: 'Review the sample result.', titleKey: 'transcript.systemEvent.reminder' });
  });

  it('recognizes a persisted restoration notice by its service-owned record id', () => {
    const [cell] = projectConversationNodes([{
      t: 'msg', ts: 1, id: 'worker-interruption:sample-worker', role: 'user', subtype: 'system_event',
      content: 'The sample session was restored. Its previous worker is no longer available.',
    }]);
    expect(cell).toMatchObject({
      kind: 'notice', source: 'session_restored', titleKey: 'transcript.systemEvent.sessionRestored',
      summary: messageText('transcript.systemEvent.sessionRestoredSummary'),
    });
  });

  it.each([
    ['ok', 'backgroundCompleted', 'neutral'],
    ['failed', 'backgroundFailed', 'danger'],
    ['killed', 'backgroundStopped', 'warning'],
  ])('preserves %s background output, its status, and the complete log link', (status, title, tone) => {
    const tail = 'Sample output contains </tail> in a code example.\nFinal sample output.';
    const [cell] = projectConversationNodes([{
      t: 'msg', ts: 1, id: 'sample-background', role: 'user', subtype: 'system_event',
      content: `<task-notification>\n<task-id>sample-job</task-id>\n<output-file>/tmp/sample-output.log</output-file>\n<status>${status}</status>\n<summary>Sample job result.</summary>\n<tail>${tail}</tail>\n</task-notification>`,
    }]);
    expect(cell).toMatchObject({
      kind: 'notice', source: 'task_notification', titleKey: `transcript.systemEvent.${title}`,
      tone, text: `Sample job result.\n\n${tail}`, summary: rawText('Sample job result.'),
    });
    expect(cell?.detail?.().sections).toEqual([
      { value: `Sample job result.\n\n${tail}`, format: 'text' },
      { value: messageText('transcript.detail.eventFile', { path: rawText('/tmp/sample-output.log') }), format: 'text' },
    ]);
  });
});

describe('通知 TranscriptNode 漏口', () => {
  it('runtime context_overflow 从持久消息投影为默认展开的失败 TranscriptNode', () => {
    const providerMessage = 'Your input exceeds the context window of this model.\n'
      + 'Please adjust your input and try again.';
    const entry: MsgEntry = {
      t: 'msg',
      ts: 1,
      id: 'failure-1',
      role: 'user',
      subtype: 'subagent_notification',
      content: `<subagent_event id="worker-1" type="failed" ts="t" error_type="context_overflow">\n${providerMessage}\n</subagent_event>`,
    };

    const [cell] = projectConversationNodes([entry]);
    expect(cell).toMatchObject({
      kind: 'notice',
      titleKey: 'transcript.notice.workerFailed',
      text: providerMessage,
      tone: 'danger',
      eventType: 'failed',
      errorType: 'context_overflow',
      defaultExpanded: false,
      meta: [messageText('transcript.summary.fromSource', { source: rawText('worker-1') })],
    });
    expect(cell?.detail?.().sections.map((section) => section.value)).toEqual([
      providerMessage,
      messageText('transcript.guidance.contextOverflow'),
    ]);
  });
});
