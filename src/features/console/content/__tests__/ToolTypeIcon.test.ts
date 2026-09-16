import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ToolNode } from '@/domains/transcript/nodes';
import { ToolTypeIcon } from '../ToolTypeIcon';

function renderIcon(tool: string): string {
  const cell = { kind: 'tool', tool } as ToolNode;
  return renderToStaticMarkup(createElement(ToolTypeIcon, { cell }));
}

describe('ToolTypeIcon', () => {
  it.each([
    ['glob', 'folder-search'],
    ['grep', 'file-search'],
    ['tool_search', 'search'],
    ['web_search', 'search'],
    ['agent_run', 'bot'],
    ['browser_skill_build', 'hammer'],
    ['browser_skill_status', 'activity'],
    ['browser_skill_publish', 'cloud-upload'],
  ])('renders %s with the lucide %s glyph', (tool, glyph) => {
    expect(renderIcon(tool)).toContain(`lucide-${glyph}`);
  });
});
