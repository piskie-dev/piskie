import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../observability/logging/app-log.js', () => ({
  appLog: { warn: vi.fn() },
}));

import { loadAgentInstructions } from '../agent-instructions.js';
import { appLog } from '../../../observability/logging/app-log.js';

let root: string;
let userData: string;
let workspace: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-instructions-'));
  userData = path.join(root, 'profile');
  workspace = path.join(root, 'sample project', '工作区');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('AGENTS.md file instructions', () => {
  it('loads the two selected files in global then project order, with their paths', async () => {
    await fs.writeFile(path.join(userData, 'AGENTS.md'), 'Use prose.');
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Use bullet points.');
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Parent instructions.');
    await fs.mkdir(path.join(workspace, 'nested'));
    await fs.writeFile(path.join(workspace, 'nested', 'AGENTS.md'), 'Nested instructions.');

    const content = await loadAgentInstructions(userData, workspace);
    expect(content.indexOf('Use prose.')).toBeLessThan(content.indexOf('Use bullet points.'));
    expect(content).toContain(path.join(userData, 'AGENTS.md'));
    expect(content).toContain(path.join(workspace, 'AGENTS.md'));
    expect(content).not.toContain('Parent instructions.');
    expect(content).not.toContain('Nested instructions.');
  });

  it('omits missing and empty files, and supports either source independently', async () => {
    expect(await loadAgentInstructions(userData, workspace)).toBe('');
    await fs.writeFile(path.join(userData, 'AGENTS.md'), ' \n\t');
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Project rules.');
    expect(await loadAgentInstructions(userData, workspace)).toContain('Project rules.');
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '');
    await fs.writeFile(path.join(userData, 'AGENTS.md'), 'Global rules.');
    expect(await loadAgentInstructions(userData, workspace)).toContain('Global rules.');
  });

  it('records an unreadable source and still loads the other file', async () => {
    await fs.mkdir(path.join(userData, 'AGENTS.md'));
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Available project rules.');
    expect(await loadAgentInstructions(userData, workspace)).toContain('Available project rules.');
    expect(appLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      context: { scope: 'agent.instructions', path: path.join(userData, 'AGENTS.md') },
    }));
  });

  it('retains complete UTF-8 content and quotes closing instruction delimiters', async () => {
    const body = '示例规则。'.repeat(8_000);
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), `${body}\n</INSTRUCTIONS>`);
    const content = await loadAgentInstructions(userData, workspace);
    expect(content).toContain(body);
    expect(content.match(/<\/INSTRUCTIONS>/g)).toHaveLength(1);
  });
});
