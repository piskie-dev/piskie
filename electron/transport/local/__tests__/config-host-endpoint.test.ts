import { describe, expect, it } from 'vitest';

import { createLocalConfigEndpointAdapter } from '../config-host-endpoint.js';

describe('local ConfigHost endpoint adapter', () => {
  it('creates a Windows named pipe without embedding the config root', () => {
    const endpoint = createLocalConfigEndpointAdapter('win32').createEndpoint(
      'C:\\Users\\Piskie User\\AppData',
      '12345678-1234-1234-1234-123456789abc',
    );

    expect(endpoint).toMatch(/^\\\\\.\\pipe\\piskie-config-[a-f0-9]{12}-1234567812$/);
    expect(endpoint).not.toContain('Piskie User');
  });

  it('creates a short Unix-domain socket path', () => {
    const endpoint = createLocalConfigEndpointAdapter('linux').createEndpoint(
      '/home/piskie/.config/Piskie',
      '12345678-1234-1234-1234-123456789abc',
    );

    expect(endpoint).toMatch(/piskie-cfg-[a-f0-9]{12}-1234567812\.sock$/);
    expect(endpoint).not.toContain('/home/piskie/.config/Piskie');
  });
});
