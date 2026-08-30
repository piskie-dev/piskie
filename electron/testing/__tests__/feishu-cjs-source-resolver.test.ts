import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface AccountIdCompat {
  DEFAULT_ACCOUNT_ID: string;
  normalizeAccountId(value: string): string;
}

describe('Feishu CJS source resolver', () => {
  it('loads a TypeScript compat module through the unchanged vendor bridge', () => {
    const require = createRequire(import.meta.url);
    const bridge = require(
      path.resolve(
        __dirname,
        '../../im-gateway/channels/feishu/vendor/openclaw-compat/account-id.js'
      )
    ) as AccountIdCompat;

    expect(bridge.DEFAULT_ACCOUNT_ID).toBe('default');
    expect(bridge.normalizeAccountId(' Team / Bot ')).toBe('team---bot');
    expect(bridge.normalizeAccountId(' Account_Name ')).toBe('account_name');
    expect(bridge.normalizeAccountId('---账户/甲---')).toBe('');
    expect(bridge.normalizeAccountId('A'.repeat(80))).toBe('a'.repeat(80));
  });
});
