import type { UserMessageMetadata } from '../../../shared/types/agent-control.js';
import { renderAvailableSkillTeaching, type SkillTeachingPort } from '../../skills/discovery/teaching.js';
import type { SkillSelectionPort, SkillWorkspaceOptions } from '../../skills/discovery/resolve.js';

const LOADED_MESSAGE = '以下用户选择的技能已完整加载，请使用这些技能完成任务。';

/** Render one user input's teaching from the same source as load_skill. */
export async function loadSelectedSkills(
  catalog: (SkillTeachingPort & SkillSelectionPort) | null,
  names: readonly string[],
  workspace: SkillWorkspaceOptions,
): Promise<{ metadata: UserMessageMetadata; instructions: string }> {
  const skills = [...new Set(names)];
  const results = await Promise.all(skills.map(async (name) => {
    try {
      if (!catalog) throw new Error('技能目录不可用');
      const teaching = await renderAvailableSkillTeaching(catalog, name, workspace);
      if (!teaching?.found) {
        throw new Error(teaching?.error ?? (teaching
          ? '无法读取技能主教学内容'
          : '当前工作区中未找到已启用的技能'));
      }
      return { name, content: teaching.content };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const loaded: string[] = [];
  const skillLoadErrors: NonNullable<UserMessageMetadata['skillLoadErrors']> = [];
  for (const result of results) {
    if (result.error !== undefined) {
      skillLoadErrors.push({ name: result.name, error: result.error });
    } else {
      loaded.push(`## ${result.name}\n\n${result.content}`);
    }
  }
  const sections: string[] = [];
  if (loaded.length) sections.push(`${LOADED_MESSAGE}\n\n${loaded.join('\n\n')}`);
  if (skillLoadErrors.length) {
    sections.push('以下用户选择的技能加载失败：\n'
      + skillLoadErrors.map(({ name, error }) => `- ${name}: ${error}`).join('\n'));
  }
  return {
    metadata: { skills, ...(skillLoadErrors.length ? { skillLoadErrors } : {}) },
    instructions: sections.join('\n\n'),
  };
}
