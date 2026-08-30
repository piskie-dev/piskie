import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultComfySocketFactory } from '../../drivers/comfyui-workflow/socket-session.js';
import {
  createNodeInferenceTransports,
  InferenceTransportConfigError,
  type NodeInferenceTransports,
} from '../node-transport.js';

const directories: string[] = [];
const activeTransports: NodeInferenceTransports[] = [];

afterEach(async () => {
  await Promise.all(activeTransports.splice(0).map((transports) => transports.close()));
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function rootWithProxy(password?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-node-transport-'));
  directories.push(root);
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'proxies.json'), JSON.stringify({
    revision: 0,
    proxies: {
      'proxy-one': {
        name: 'Local proxy',
        protocol: 'http',
        host: '127.0.0.1',
        port: 10808,
        enabled: true,
        ...(password && { password }),
      },
    },
  }));
  return root;
}

describe('Node inference transports', () => {
  it('does not read proxy configuration for direct connections', () => {
    const transports = createNodeInferenceTransports('/path/that/does/not/exist');
    activeTransports.push(transports);

    expect(transports.resolveFetch(null, globalThis.fetch)).toBe(globalThis.fetch);
    expect(transports.resolveSocketFactory(null, defaultComfySocketFactory))
      .toBe(defaultComfySocketFactory);
  });

  it('builds both HTTP and WebSocket transports from one plaintext profile', async () => {
    const transports = createNodeInferenceTransports(await rootWithProxy('plain-password'));
    activeTransports.push(transports);

    expect(transports.resolveFetch('proxy-one', globalThis.fetch)).not.toBe(globalThis.fetch);
    expect(transports.resolveSocketFactory('proxy-one', defaultComfySocketFactory))
      .not.toBe(defaultComfySocketFactory);
  });

  it('rejects a missing proxy profile instead of silently connecting directly', async () => {
    const plaintext = createNodeInferenceTransports(await rootWithProxy());
    activeTransports.push(plaintext);
    expect(() => plaintext.resolveFetch('missing', globalThis.fetch)).toThrowError(
      expect.objectContaining<Partial<InferenceTransportConfigError>>({ code: 'INFERENCE_PROXY_NOT_FOUND' }),
    );
  });

  it('ignores unknown persisted keys at the read boundary', async () => {
    const root = await rootWithProxy();
    const file = path.join(root, 'config', 'proxies.json');
    const document = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    document.retiredRootField = true;
    const proxies = document.proxies as Record<string, Record<string, unknown>>;
    proxies['proxy-one']!.retiredProfileField = true;
    await fs.writeFile(file, JSON.stringify(document));
    const transports = createNodeInferenceTransports(root);
    activeTransports.push(transports);

    expect(transports.resolveFetch('proxy-one', globalThis.fetch)).not.toBe(globalThis.fetch);
  });
});
