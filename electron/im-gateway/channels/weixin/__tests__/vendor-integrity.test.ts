import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildBaseInfo, readPackageJsonFromDir } from '../vendor/src/api/api.js';
import { sendMessageWeixin } from '../vendor/src/messaging/send.js';
import { redactBody } from '../vendor/src/util/redact.js';

function listJs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listJs(full) : entry.name.endsWith('.js') ? [full] : [];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Weixin 2.4.6 vendor integrity', () => {
  it('contains the clean 35-file baseline without old runtime or raw OpenClaw imports', () => {
    const vendorRoot = path.resolve(__dirname, '../vendor');
    const files = listJs(path.join(vendorRoot, 'src'));
    expect(files).toHaveLength(35);
    expect(fs.existsSync(path.join(vendorRoot, 'src/runtime.js'))).toBe(false);
    expect(fs.existsSync(path.join(vendorRoot, 'src/runtime.d.ts'))).toBe(false);
    expect(files.map((file) => fs.readFileSync(file, 'utf8')).join('\n'))
      .not.toContain('openclaw/plugin-sdk/');

    const pkg = readPackageJsonFromDir(path.join(vendorRoot, 'src', 'api'));
    expect(pkg).toMatchObject({
      name: '@tencent-weixin/openclaw-weixin',
      version: '2.4.6',
      ilink_appid: 'bot',
    });
    expect(buildBaseInfo()).toMatchObject({ channel_version: '2.4.6' });
  });

  it('uses the package protocol headers and leaves Content-Length to undici', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ret":0}',
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await sendMessageWeixin({
      to: 'user@im.wechat',
      text: 'hello',
      opts: { baseUrl: 'https://example.test', token: 'token', contextToken: 'context' },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['iLink-App-Id']).toBe('bot');
    expect(headers['iLink-App-ClientVersion']).toBe(String((2 << 16) | (4 << 8) | 6));
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('content-length');
    expect(JSON.parse(String(init.body)).base_info.channel_version).toBe('2.4.6');
  });

  it('redacts local login tokens and upload keys from diagnostics', () => {
    const redacted = redactBody(JSON.stringify({
      local_token_list: ['secret-token'],
      aeskey: 'secret-aes-key',
      context_token: 'secret-context',
    }), 1000);
    expect(redacted).not.toContain('secret-token');
    expect(redacted).not.toContain('secret-aes-key');
    expect(redacted).not.toContain('secret-context');
  });
});
