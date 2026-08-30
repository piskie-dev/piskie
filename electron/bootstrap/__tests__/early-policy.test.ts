import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  appendSwitch: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  setAppUserModelId: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: electron.appendSwitch },
    requestSingleInstanceLock: electron.requestSingleInstanceLock,
    setAppUserModelId: electron.setAppUserModelId,
  },
}));

import { installEarlyElectronPolicy } from '../early-policy.js';

beforeEach(() => {
  vi.clearAllMocks();
  electron.requestSingleInstanceLock.mockReturnValue(true);
});

describe('installEarlyElectronPolicy', () => {
  it('keeps GNOME with Fcitx on native Wayland and enables its IME integration', () => {
    expect(
      installEarlyElectronPolicy('linux', {
        XDG_SESSION_TYPE: 'wayland',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
        GTK_IM_MODULE: 'fcitx',
        XMODIFIERS: '@im=fcitx',
      })
    ).toEqual({ primaryInstance: true });

    expect(electron.appendSwitch).toHaveBeenCalledWith('enable-wayland-ime');
    expect(electron.appendSwitch).not.toHaveBeenCalledWith('ozone-platform', 'x11');
  });

  it('enables native Chromium IME integration for other Wayland sessions', () => {
    installEarlyElectronPolicy('linux', {
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'KDE',
      GTK_IM_MODULE: 'fcitx',
    });

    expect(electron.appendSwitch).toHaveBeenCalledWith('enable-wayland-ime');
  });

  it('also detects Wayland when only WAYLAND_DISPLAY is available', () => {
    installEarlyElectronPolicy('linux', { WAYLAND_DISPLAY: 'wayland-0' });

    expect(electron.appendSwitch).toHaveBeenCalledWith('enable-wayland-ime');
  });

  it('does not enable the Wayland integration for X11 or non-Linux sessions', () => {
    installEarlyElectronPolicy('linux', {
      XDG_SESSION_TYPE: 'x11',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'stale-wayland-value',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      GTK_IM_MODULE: 'fcitx',
    });
    installEarlyElectronPolicy('darwin', { XDG_SESSION_TYPE: 'wayland' });

    expect(electron.appendSwitch).not.toHaveBeenCalled();
  });

  it('keeps the Windows application identity policy', () => {
    installEarlyElectronPolicy('win32', {});

    expect(electron.setAppUserModelId).toHaveBeenCalledWith('dev.piskie.desktop');
  });
});
