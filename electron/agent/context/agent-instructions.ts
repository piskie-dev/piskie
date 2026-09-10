import { promises as fs } from 'node:fs';
import path from 'node:path';

import { appLog } from '../../observability/logging/app-log.js';
import { neutralizeClosing } from '../prompts/context.js';

/** Load global and workspace-root instructions once for a Runtime. */
export async function loadAgentInstructions(userDataDir: string, workspace: string): Promise<string> {
  const sources = [
    { label: '全局规则', file: path.join(userDataDir, 'AGENTS.md') },
    { label: '项目规则', file: path.join(workspace, 'AGENTS.md') },
  ];
  const sections = await Promise.all(sources.map(async ({ label, file }) => {
    try {
      const content = (await fs.readFile(file, 'utf8')).trim();
      return content ? `## ${label}：${file}\n${content}` : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        appLog.warn({
          event: 'agent.instructions.load.failed',
          message: 'Agent instructions could not be read',
          context: { scope: 'agent.instructions', path: file },
          error,
        });
      }
      return undefined;
    }
  }));
  const body = sections.filter((section) => section !== undefined).join('\n\n');
  if (!body) return '';
  return '# AGENTS.md instructions\n\n'
    + '以下规则适用于当前任务。项目规则与全局规则冲突时，优先遵循项目规则。\n\n'
    + `<INSTRUCTIONS>\n${neutralizeClosing('INSTRUCTIONS', body)}\n</INSTRUCTIONS>`;
}
