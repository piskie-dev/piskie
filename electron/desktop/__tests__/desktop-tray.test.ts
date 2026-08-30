import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(() => ''),
}));

vi.mock('node:child_process', () => ({
  execFileSync: childProcess.execFileSync,
}));

const electron = vi.hoisted(() => {
  class FakeNativeImage {
    readonly resize = vi.fn(() => this);
    readonly toPNG = vi.fn(() => Buffer.from('icon'));
    readonly addRepresentation = vi.fn();
    readonly setTemplateImage = vi.fn();

    constructor(readonly source: string) {}
  }

  class FakeTray {
    static readonly instances: FakeTray[] = [];
    readonly setToolTip = vi.fn();
    readonly setContextMenu = vi.fn();
    readonly setImage = vi.fn();
    readonly setTitle = vi.fn();
    readonly on = vi.fn();
    readonly popUpContextMenu = vi.fn();
    readonly destroy = vi.fn();

    constructor(readonly icon: FakeNativeImage) {
      FakeTray.instances.push(this);
    }
  }

  const nativeThemeListeners = new Set<() => void>();
  const nativeTheme = {
    shouldUseDarkColorsForSystemIntegratedUI: false,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'updated') nativeThemeListeners.add(listener);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'updated') nativeThemeListeners.delete(listener);
    }),
  };

  return {
    FakeNativeImage,
    FakeTray,
    buildFromTemplate: vi.fn(() => ({})),
    createEmpty: vi.fn(() => new FakeNativeImage('empty')),
    createFromPath: vi.fn((source: string) => new FakeNativeImage(source)),
    nativeTheme,
    emitNativeThemeUpdated: () => {
      for (const listener of nativeThemeListeners) listener();
    },
    resetNativeTheme: () => {
      nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
      nativeThemeListeners.clear();
    },
  };
});

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  Tray: electron.FakeTray,
  nativeImage: {
    createEmpty: electron.createEmpty,
    createFromPath: electron.createFromPath,
  },
  nativeTheme: electron.nativeTheme,
}));

import { DesktopTray } from '../desktop-tray.js';

function registryOutput(systemUsesLightTheme: 0 | 1): string {
  return [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    `    SystemUsesLightTheme    REG_DWORD    0x${systemUsesLightTheme}`,
  ].join('\r\n');
}

beforeEach(() => {
  electron.FakeTray.instances.length = 0;
  electron.resetNativeTheme();
  vi.clearAllMocks();
  childProcess.execFileSync.mockReset();
  childProcess.execFileSync.mockReturnValue(registryOutput(0));
});

function fixture(platform: NodeJS.Platform = 'linux'): DesktopTray {
  const releaseControlStates = vi.fn();
  const releaseRuntimes = vi.fn();
  return new DesktopTray({
    platform,
    lightGlyphPath: '/app/tray-glyph-light.png',
    darkGlyphPath: '/app/tray-glyph-dark.png',
    observations: {
      controlStateChanges: { subscribe: vi.fn(() => releaseControlStates) },
      runtimeReleases: { subscribe: vi.fn(() => releaseRuntimes) },
    } as never,
    onSummon: vi.fn(),
    onQuit: vi.fn(),
  });
}

describe('DesktopTray platform icons', () => {
  it('uses the light monochrome glyph on Linux', () => {
    const tray = fixture('linux');
    tray.start();
    const nativeTray = electron.FakeTray.instances[0]!;

    expect(nativeTray.icon.source).toBe('/app/tray-glyph-light.png');
    expect(electron.nativeTheme.on).not.toHaveBeenCalled();
    tray.dispose();
  });

  it('uses the Windows system theme when Electron initially reports the app theme', () => {
    vi.useFakeTimers();
    let tray: DesktopTray | undefined;
    try {
      tray = fixture('win32');
      tray.start();
      const nativeTray = electron.FakeTray.instances[0]!;
      const source = electron.createFromPath.mock.results[0]!.value as InstanceType<
        typeof electron.FakeNativeImage
      >;

      expect(electron.createFromPath).toHaveBeenLastCalledWith('/app/tray-glyph-light.png');
      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
          '/v',
          'SystemUsesLightTheme',
        ],
        { encoding: 'utf8', timeout: 1000, windowsHide: true },
      );
      expect(source.resize).toHaveBeenNthCalledWith(1, { width: 16, height: 16, quality: 'best' });
      expect(source.resize).toHaveBeenNthCalledWith(2, { width: 20, height: 20, quality: 'best' });
      expect(source.resize).toHaveBeenNthCalledWith(3, { width: 24, height: 24, quality: 'best' });
      expect(source.resize).toHaveBeenNthCalledWith(4, { width: 32, height: 32, quality: 'best' });
      expect(nativeTray.icon.addRepresentation).toHaveBeenCalledTimes(4);
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ scaleFactor: 1 }),
      );
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ scaleFactor: 1.25 }),
      );
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ scaleFactor: 1.5 }),
      );
      expect(nativeTray.icon.addRepresentation).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ scaleFactor: 2 }),
      );
      expect(electron.nativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));

      childProcess.execFileSync.mockReturnValue(registryOutput(1));
      electron.emitNativeThemeUpdated();
      expect(nativeTray.setImage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);

      expect(electron.createFromPath).toHaveBeenLastCalledWith('/app/tray-glyph-dark.png');
      const updatedIcon = nativeTray.setImage.mock.calls[0]![0] as InstanceType<
        typeof electron.FakeNativeImage
      >;
      expect(updatedIcon.addRepresentation).toHaveBeenCalledTimes(4);
      tray.dispose();
      tray = undefined;
      expect(electron.nativeTheme.removeListener).toHaveBeenCalledWith('updated', expect.any(Function));
    } finally {
      tray?.dispose();
      vi.useRealTimers();
    }
  });

  it('falls back to Electron nativeTheme when the Windows registry query fails', () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    electron.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
    const tray = fixture('win32');
    tray.start();

    expect(electron.createFromPath).toHaveBeenLastCalledWith('/app/tray-glyph-light.png');
    tray.dispose();
  });

  it('marks the macOS glyph as a template image', () => {
    const tray = fixture('darwin');
    tray.start();
    const nativeTray = electron.FakeTray.instances[0]!;

    expect(electron.createFromPath).toHaveBeenCalledWith('/app/tray-glyph-light.png');
    expect(nativeTray.icon.setTemplateImage).toHaveBeenCalledWith(true);
    expect(nativeTray.icon.addRepresentation).toHaveBeenCalledTimes(2);
    expect(electron.nativeTheme.on).not.toHaveBeenCalled();
    tray.dispose();
  });
});
