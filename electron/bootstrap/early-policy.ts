import { app } from 'electron';

export interface EarlyPolicyResult {
  readonly primaryInstance: boolean;
}

function isWaylandSession(environment: NodeJS.ProcessEnv): boolean {
  const sessionType = environment.XDG_SESSION_TYPE?.toLowerCase();
  if (sessionType === 'x11') return false;
  if (sessionType === 'wayland') return true;
  return !!environment.WAYLAND_DISPLAY;
}

export function installEarlyElectronPolicy(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): EarlyPolicyResult {
  if (platform === 'linux' && isWaylandSession(environment)) {
    app.commandLine.appendSwitch('enable-wayland-ime');
  }

  const primaryInstance = app.requestSingleInstanceLock();
  if (platform === 'win32') app.setAppUserModelId('dev.piskie.desktop');
  return Object.freeze({ primaryInstance });
}
