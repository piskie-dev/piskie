/** A catalog label source for tools that are not part of the built-in title map. */
export type TitleSource = (tool: string) => string | undefined;

export interface ToolTitleDescriptor {
  readonly titleKey: string;
  readonly titleArgs?: Readonly<Record<string, string | number>>;
}

const STATIC_TITLE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ask_user: 'transcript.tool.askUser',
  subagent: 'transcript.tool.manageWorker',
  plan: 'transcript.tool.plan',
  send_event: 'transcript.tool.sendEvent',
  skill_call: 'transcript.tool.skillCall',
  load_skill: 'transcript.tool.loadSkill',
  tool_search: 'transcript.tool.searchCapabilities',
  read: 'transcript.tool.readFile',
  write: 'transcript.tool.writeFile',
  edit: 'transcript.tool.editFile',
  ls: 'transcript.tool.listFiles',
  glob: 'transcript.tool.searchPaths',
  grep: 'transcript.tool.searchContent',
  shell: 'transcript.tool.runCommand',
  browser_takeScreenshot: 'transcript.tool.browserScreenshot',
});

export interface ToolTitleInput {
  readonly tool: string;
  readonly params?: unknown;
}

export function resolveToolTitle(
  input: ToolTitleInput,
  source?: TitleSource,
): ToolTitleDescriptor {
  const params = input.params as Record<string, unknown> | undefined;
  const action = typeof params?.action === 'string' ? params.action : undefined;

  if (input.tool === 'skill_call') {
    const skill = typeof params?.skill === 'string' ? params.skill : '';
    const fn = typeof params?.function === 'string' ? params.function : '';
    if (skill && fn) {
      return {
        titleKey: 'transcript.tool.skillFunction',
        titleArgs: { function: `${skill}.${fn}` },
      };
    }
  }

  if (input.tool === 'subagent') {
    return {
      titleKey: action === 'stop'
        ? 'transcript.tool.stopWorker'
        : 'transcript.tool.createWorker',
    };
  }
  if (input.tool === 'plan') {
    if (action === 'create') return { titleKey: 'transcript.tool.submitPlan' };
    if (action === 'read') return { titleKey: 'transcript.tool.readPlan' };
  }
  if (input.tool === 'task') return { titleKey: 'transcript.tool.syncTaskBoard' };

  const staticKey = STATIC_TITLE_KEYS[input.tool];
  if (staticKey) return { titleKey: staticKey };
  const catalogLabel = source?.(input.tool);
  return catalogLabel
    ? { titleKey: 'transcript.tool.catalogLabel', titleArgs: { label: catalogLabel } }
    : { titleKey: 'transcript.tool.generic', titleArgs: { tool: input.tool } };
}
