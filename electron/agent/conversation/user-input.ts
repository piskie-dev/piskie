import type { UserMessageInput } from '../../../shared/types/user-input.js';

/** Project the submitted input into model text; display reads the original input. */
export function userInputModelText(input: UserMessageInput): string {
  if (!input.files?.length) return input.text;
  const paths = input.files.map((file) => `- ${file.path}`).join('\n');
  return `${input.text ? `${input.text}\n\n` : ''}附件文件路径：\n${paths}`;
}
