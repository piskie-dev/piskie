import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));

import { ConversationStore } from '../../../agent-runs/conversation-store.js';
import type { AgentHost } from '../../agent-host.js';
import { BrowserModule } from '../browser.module.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-browser-screenshot-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('BrowserModule screenshot owner paths', () => {
  it('requires the Worker creation contract to provide an explicit mode', () => {
    const module = new BrowserModule();
    expect(() => module.init({} as AgentHost, {})).toThrow(
      'BrowserModule requires an explicit browser or local mode',
    );
  });

  it.each([
    ['Main', 'main-1', path.join('agent-runs', 'main-1', 'screenshots')],
    ['Worker', 'worker-1', path.join('agent-runs', 'main-1', 'workers', 'worker-1', 'screenshots')],
  ])('injects a host-only file path under the %s owner', async (_kind, agentId, relativeDir) => {
    const store = new ConversationStore(root);
    const module = new BrowserModule();
    module.init({
      id: agentId,
      mainAgentId: 'main-1',
      getConversationStore: () => store,
    } as unknown as AgentHost, { mode: 'local' });
    const params: Record<string, unknown> = { format: 'webp', fullPage: true };

    const target = await module.prepareScreenshot(params);

    expect(target.mainAgentId).toBe('main-1');
    expect(target.agentId).toBe(agentId);
    expect(path.dirname(target.filePath)).toBe(path.join(root, relativeDir));
    expect(params).toEqual({
      format: 'webp',
      fullPage: true,
      filePath: target.filePath,
    });
    expect(fs.existsSync(path.join(root, 'screenshots'))).toBe(false);
  });
});
