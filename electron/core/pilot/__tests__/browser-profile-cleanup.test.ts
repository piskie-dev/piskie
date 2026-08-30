import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));


import { setPilotRoot } from '../../../piskiepilot/paths.js';
import { browserControlPort } from '../pilot-manager.js';

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-profile-cleanup-'));
  setPilotRoot(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function seedProfiles(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => fs.mkdir(path.join(root, 'user-data', id), { recursive: true })));
}

async function seedBrowserConfigs(ids: string[]): Promise<void> {
  await fs.mkdir(path.join(root, 'browsers'), { recursive: true });
  await Promise.all(ids.map((id) => fs.writeFile(path.join(root, 'browsers', `${id}.json`), '{}')));
}

async function names(directory: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, directory)).catch(() => [])).sort();
}

describe('browser Profile cleanup ownership', () => {
  it('deletes only the exact AgentRun owners requested by AgentService', async () => {
    const resources = ['main-1', 'worker-1', 'main-2', 'environment-profile'];
    await seedProfiles(resources);
    await seedBrowserConfigs(resources);

    await browserControlPort.deleteUserDataById('main-1');
    await browserControlPort.deleteUserDataById('worker-1');

    expect(await names('user-data')).toEqual(['environment-profile', 'main-2']);
    expect(await names('browsers')).toEqual([
      'environment-profile.json',
      'main-2.json',
    ]);
  });

  it('still cleans browser configs when the user-data root is absent', async () => {
    await seedBrowserConfigs(['worker-1', 'unrelated']);
    await browserControlPort.deleteUserDataById('worker-1');
    expect(await names('browsers')).toEqual(['unrelated.json']);
  });

  it('still cleans browser configs when scanning the user-data root fails', async () => {
    await fs.writeFile(path.join(root, 'user-data'), 'not a directory');
    await seedBrowserConfigs(['worker-1', 'unrelated']);

    await browserControlPort.deleteUserDataById('worker-1');

    expect(await names('browsers')).toEqual(['unrelated.json']);
  });

  it('still cleans Profiles when scanning browser configs fails', async () => {
    await seedProfiles(['worker-1', 'unrelated']);
    await fs.writeFile(path.join(root, 'browsers'), 'not a directory');

    await browserControlPort.deleteUserDataById('worker-1');

    expect(await names('user-data')).toEqual(['unrelated']);
  });

  it('environment deletion removes only the exact Profile ID', async () => {
    await seedProfiles(['login-profile', 'login-profile-copy']);
    await seedBrowserConfigs(['login-profile']);
    await browserControlPort.deleteUserDataById('login-profile');
    expect(await names('user-data')).toEqual(['login-profile-copy']);
    expect(await names('browsers')).toEqual([]);
  });
});
