import type {
  AssignmentTaskBoardSnapshot,
  SubagentConfig,
} from '../../shared/types/index.js';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function neutralizeAssignmentClosings(text: string): string {
  return ['prompt', 'assignment', 'task_board'].reduce(
    (result, tag) => result.replace(new RegExp(`</${tag}\\s*>`, 'g'), `<\\/${tag}>`),
    text,
  );
}

export function renderAssignmentInitialMessage(
  config: Pick<SubagentConfig, 'prompt'>,
  snapshot: AssignmentTaskBoardSnapshot,
): string {
  const items = snapshot.items.map((item) => {
    const attributes = [
      `id="${xmlEscape(item.id)}"`,
      `subject="${xmlEscape(item.subject)}"`,
      `status="${xmlEscape(item.status)}"`,
      `owner="${xmlEscape(item.owner ?? 'unassigned')}"`,
      `assigned_here="${item.assignedHere ? 'true' : 'false'}"`,
    ].join('\n        ');
    const dependencies = item.dependsOn.length === 0
      ? '    <depends_on/>'
      : `    <depends_on>\n${item.dependsOn
        .map((taskId) => `      <task_id>${xmlEscape(taskId)}</task_id>`)
        .join('\n')}\n    </depends_on>`;
    return `  <item ${attributes}>\n${dependencies}\n  </item>`;
  }).join('\n');

  return `<assignment>
  <prompt>
${neutralizeAssignmentClosings(config.prompt)}
  </prompt>
</assignment>

<task_board summary="${xmlEscape(snapshot.taskSummary)}">
${items}
</task_board>`;
}
