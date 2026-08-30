import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LocalConfigEndpointAdapter {
  createEndpoint(rootDirectory: string, instanceId: string): string;
  secureEndpoint(endpoint: string): Promise<void>;
  secureRuntimeDirectory(directory: string): Promise<void>;
  removeEndpoint(endpoint: string): Promise<void>;
}

export function createLocalConfigEndpointAdapter(
  platform: NodeJS.Platform = process.platform,
): LocalConfigEndpointAdapter {
  const windows = platform === 'win32';
  return {
    createEndpoint(rootDirectory, instanceId) {
      const rootHash = createHash('sha256').update(rootDirectory).digest('hex').slice(0, 12);
      const suffix = instanceId.replaceAll('-', '').slice(0, 10);
      return windows
        ? `\\\\.\\pipe\\piskie-config-${rootHash}-${suffix}`
        : path.join(os.tmpdir(), `piskie-cfg-${rootHash}-${suffix}.sock`);
    },
    async secureEndpoint(endpoint) {
      if (!windows) await fs.chmod(endpoint, 0o600);
    },
    async secureRuntimeDirectory(directory) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (!windows) await fs.chmod(directory, 0o700);
    },
    async removeEndpoint(endpoint) {
      if (windows) return;
      await fs.unlink(endpoint).catch((cause: unknown) => {
        if (!isNodeError(cause, 'ENOENT')) throw cause;
      });
    },
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
