import { appLog } from '@electron/observability/logging/app-log.js';
import { ensureBinary } from '../../piskiepilot/browser/fingerprint/downloader.js';
import { installConfigCliLauncher } from '../../inference/config-cli/launcher.js';
import type { RuntimeComponent } from '../component-manifest.js';

export interface HostAssetsState {
  commandPath?: string;
  browserKernelPath?: string;
  browserKernelError?: string;
}

export function createHostAssetsComponent(options: {
  userDataDirectory: string;
  state: HostAssetsState;
}): RuntimeComponent<Readonly<HostAssetsState>> {
  let kernelTask: Promise<void> | undefined;
  let kernelSettled = false;

  const waitForKernel = async (): Promise<void> => {
    await kernelTask;
  };

  return {
    id: 'host-assets',
    requirement: 'optional',
    dependsOn: ['storage'],
    async start(_context, scope) {
      const launcher = await installConfigCliLauncher({
        userDataDirectory: options.userDataDirectory,
      });
      options.state.commandPath = launcher.commandPath;

      kernelTask = ensureBinary()
        .then((executablePath) => {
          options.state.browserKernelPath = executablePath;
          appLog.info({
            event: 'browser.kernel.prepare.completed',
            message: 'Browser kernel prepared',
            context: { scope: 'browser.kernel' },
          });
        })
        .catch((error: unknown) => {
          options.state.browserKernelError = error instanceof Error ? error.message : String(error);
          appLog.warn({
            event: 'browser.kernel.prepare.degraded',
            message: 'Browser kernel preparation degraded',
            context: { scope: 'browser.kernel' },
            error: error,
          });
        })
        .finally(() => {
          kernelSettled = true;
        });

      scope.register({
        kind: 'custom',
        label: 'browser-kernel-installation',
        close: waitForKernel,
        inspect: () => (kernelSettled ? 'closed' : 'live'),
        describe: () => ({
          commandPath: options.state.commandPath,
          browserKernelPath: options.state.browserKernelPath,
          browserKernelError: options.state.browserKernelError,
        }),
      });
      return options.state;
    },
    stop: waitForKernel,
    async verifyStopped() {
      return {
        state: !kernelTask || kernelSettled ? 'stopped' : 'live',
        details: {
          commandPath: options.state.commandPath,
          browserKernelPath: options.state.browserKernelPath,
          browserKernelError: options.state.browserKernelError,
        },
      };
    },
  };
}
