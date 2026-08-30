export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'unknown' | (string & {});

export type PrimaryModifierKey = 'cmd' | 'ctrl';

interface ModifierKeyState {
  ctrlKey: boolean;
  metaKey: boolean;
}

const UNKNOWN_PLATFORM: DesktopPlatform = 'unknown';

function getDesktopPlatform(): DesktopPlatform {
  if (typeof window === 'undefined') {
    return UNKNOWN_PLATFORM;
  }

  return window.piskie?.desktop.system.platform ?? UNKNOWN_PLATFORM;
}

export function isMacOSPlatform(platform: DesktopPlatform = getDesktopPlatform()): boolean {
  return platform === 'darwin';
}

export function getPrimaryModifierKey(
  platform: DesktopPlatform = getDesktopPlatform()
): PrimaryModifierKey {
  return isMacOSPlatform(platform) ? 'cmd' : 'ctrl';
}

export function hasPrimaryModifierKey(
  event: ModifierKeyState,
  platform: DesktopPlatform = getDesktopPlatform()
): boolean {
  return isMacOSPlatform(platform) ? event.metaKey : event.ctrlKey;
}
