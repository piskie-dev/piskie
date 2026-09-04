import { describe, expect, it } from 'vitest';

import type { CapabilityId } from '../../../../shared/electron-contracts/protocol.js';
import { ELECTRON_PROTOCOL_VERSION } from '../../../../shared/electron-contracts/protocol.js';
import { decodeHostFrame } from '../protocol-codec.js';

const CURRENT_CAPABILITIES: CapabilityId[] = [
  'account',
  'agent-runs',
  'agents',
  'capabilities',
  'configuration',
  'desktop',
  'inference',
  'messaging',
  'modes',
  'observability',
  'pilot',
  'runtime',
  'task-definitions',
  'updates',
];

function welcome(capabilities: unknown[]) {
  return {
    kind: 'welcome',
    welcome: {
      protocolVersion: ELECTRON_PROTOCOL_VERSION,
      generation: 'generation-1',
      connectionId: 'connection-1',
      runtime: { phase: 'ready', startedAt: 1, degraded: [] },
      capabilities,
    },
  };
}

describe('Electron protocol capability decoding', () => {
  it('accepts every current capability including both halves of the retired Flow domain', () => {
    expect(decodeHostFrame(welcome(CURRENT_CAPABILITIES))).toMatchObject({
      kind: 'welcome',
      welcome: { capabilities: CURRENT_CAPABILITIES },
    });
  });

  it('rejects the retired mixed Flow capability', () => {
    expect(() => decodeHostFrame(welcome(['flows']))).toThrow('Invalid capability list');
  });
});
