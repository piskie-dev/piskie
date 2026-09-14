import type { PersistedMessageBlock, PersistedToolResultBlock, ToolEntry } from './types/agent-control.js';

/** Image references already resolved by the conversation owner for presentation. */
export function imagePaths(blocks: readonly (PersistedMessageBlock | PersistedToolResultBlock)[] | string): string[] {
  if (typeof blocks === 'string') return [];
  return blocks.flatMap((block) => block.type === 'image_ref' ? [block.path] : []);
}

/** The generated result uses JSON string escaping to keep each committed path on one line. */
export function generatedImagePaths(tool: string, text: string | undefined): string[] {
  if (tool !== 'generate_image' || !text) return [];
  const unwrapped = text.startsWith('<error>') && text.endsWith('</error>')
    ? text.slice('<error>'.length, -'</error>'.length) : text;
  const paths: string[] = [];
  for (const line of unwrapped.split('\n')) {
    const match = /^- \[成功\] ("(?:[^"\\]|\\.)*")(?:（.*）)?$/.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (typeof value === 'string' && value.length > 0) paths.push(value);
    } catch {
      // A malformed persisted result is not a displayable path.
    }
  }
  return paths;
}

export function toolImagePaths(tool: string, entry: ToolEntry): string[] {
  const text = entry.result.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  return [...imagePaths(entry.result), ...generatedImagePaths(tool, text)];
}
