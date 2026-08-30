import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function sourceFiles(relativeRoot: string): string[] {
  const root = path.join(ROOT, relativeRoot);
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'vendor' && entry.name !== 'build') visit(target);
      } else if (entry.name.endsWith('.ts')) {
        files.push(target);
      }
    }
  };
  visit(root);
  return files;
}

describe('domain observation architecture boundaries', () => {
  it('does not restore the deleted global event service', () => {
    const removedFile = path.join(ROOT, 'electron/services', ['event', 'service', 'ts'].join('.'));
    expect(fs.existsSync(removedFile)).toBe(false);

    const universalSingleton = ['event', 'Service'].join('');
    const concreteServiceImport = ['services/event', 'service'].join('.');
    const internalChannels = [
      ['agent', 'content'].join(':'),
      ['agent', 'state-change'].join(':'),
      ['conversation', 'append'].join(':'),
    ];
    const files = [
      ...sourceFiles('electron/agent'),
      ...sourceFiles('electron/services'),
      ...sourceFiles('electron/capabilities'),
      ...sourceFiles('electron/transport'),
      ...sourceFiles('electron/im-gateway'),
      path.join(ROOT, 'electron/main.ts'),
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      expect(source, file).not.toContain(universalSingleton);
      expect(source, file).not.toContain(concreteServiceImport);
      for (const channel of internalChannels) expect(source, file).not.toContain(channel);
    }
  });

  it('keeps domain change sources independent of Electron window APIs', () => {
    for (const relativePath of [
      'electron/core/change-channel.ts',
      'electron/agent/observations.ts',
      'electron/market/change-source.ts',
      'electron/core/occupancy/registry.ts',
    ]) {
      const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
      expect(source, relativePath).not.toContain("from 'electron'");
      expect(source, relativePath).not.toContain('BrowserWindow');
      expect(source, relativePath).not.toContain('ipcMain');
    }
  });
});
