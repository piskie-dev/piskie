import type {
  SubagentConfig,
} from '../../shared/types/index.js';

function neutralizeAssignmentClosings(text: string): string {
  return ['prompt', 'assignment'].reduce(
    (result, tag) => result.replace(new RegExp(`</${tag}\\s*>`, 'g'), `<\\/${tag}>`),
    text,
  );
}

export function renderAssignmentInitialMessage(
  config: Pick<SubagentConfig, 'prompt'>,
): string {
  return `<assignment>
  <prompt>
${neutralizeAssignmentClosings(config.prompt)}
  </prompt>
</assignment>`;
}
