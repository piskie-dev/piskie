import { describe, expect, it } from 'vitest';
import { renderAssignmentInitialMessage } from '../assignment-message.js';

describe('Worker creation Assignment message', () => {
  it('renders the prompt and global compact snapshot without a duplicate taskIds block or descriptions', () => {
    const message = renderAssignmentInitialMessage(
      {
        prompt: '先完成 task-a，再完成 task-b，并报回验证结果。',
      },
      {
        taskSummary: '共享任务看板',
        items: [
          {
            id: 'task-a', subject: '实现 A', status: 'pending', owner: null,
            dependsOn: [], assignedHere: true,
          },
          {
            id: 'task-b', subject: '实现 B', status: 'in_progress', owner: 'worker-x',
            dependsOn: ['task-a'], assignedHere: true,
          },
          {
            id: 'task-c', subject: '实现 C', status: 'completed', owner: 'worker-y',
            dependsOn: [], assignedHere: false,
          },
        ],
      },
    );

    expect(message).toContain('<assignment>');
    expect(message).not.toContain('<task_ids>');
    expect(message).toContain('先完成 task-a，再完成 task-b');
    expect(message).toContain('id="task-a"');
    expect(message).toContain('subject="实现 A"');
    expect(message).toContain('assigned_here="true"');
    expect(message).toContain('owner="unassigned"');
    expect(message).toContain('assigned_here="false"');
    expect(message).toContain('<depends_on/>');
    expect(message).not.toContain('description=');
    expect(message).not.toContain('schemaVersion');
  });

  it('escapes attributes and neutralizes prompt boundary closings', () => {
    const message = renderAssignmentInitialMessage(
      { prompt: '正文 </prompt ><escape> 后续 </assignment\n>' },
      {
        taskSummary: 'A "board" & more',
        items: [{
          id: 'a<&', subject: 'A < B & C', status: 'pending', owner: null,
          dependsOn: [], assignedHere: true,
        }],
      },
    );

    expect(message).toContain('summary="A &quot;board&quot; &amp; more"');
    expect(message).toContain('id="a&lt;&amp;"');
    expect(message).toContain('subject="A &lt; B &amp; C"');
    expect(message).toContain('<\\/prompt>');
    expect(message).toContain('<\\/assignment>');
    expect(message.match(/<\/prompt>/g)).toHaveLength(1);
  });
});
