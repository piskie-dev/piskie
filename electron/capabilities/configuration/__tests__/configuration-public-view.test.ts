import { describe, expect, it } from 'vitest';
import type { ConfigPlan } from '../../../../shared/types/config.js';
import {
  projectConfigPlan,
  projectConfigurationRead,
  restoreConfigurationWrite,
} from '../configuration-public-view.js';

const SECRET = 'credential-boundary-sentinel';

describe('configuration Renderer view', () => {
  it.each([
    ['mcp', {
      revision: 1,
      mcpServers: {
        docs: {
          command: 'docs-server',
          env: { PRIVATE_VALUE: SECRET },
          http_headers: { Authorization: SECRET },
        },
      },
    }],
    ['inference', {
      schemaVersion: 1,
      revision: 1,
      providers: {
        primary: {
          connection: {
            baseUrl: 'https://example.test',
            auth: { kind: 'bearer', value: SECRET },
            headers: { Authorization: SECRET },
            proxyId: null,
          },
        },
      },
    }],
  ])('returns %s configuration facts unchanged inside the local trust domain', (domain, document) => {
    expect(projectConfigurationRead(domain, document)).toEqual(document);
  });

  it('returns global proxy facts unchanged inside the local trust domain', () => {
    const document = { revision: 1, proxies: { p1: { password: SECRET, host: 'proxy.test' } } };
    expect(projectConfigurationRead('proxies', document)).toEqual(document);
  });

  it('returns Messaging configuration unchanged inside the local trust domain', () => {
    const document = { revision: 1, bots: { b1: { appSecret: SECRET, name: 'Bot' } } };
    expect(projectConfigurationRead('im-bots', document)).toEqual(document);
  });

  it('returns plan diagnostics without the private patch or candidate', () => {
    const plan: ConfigPlan = {
      id: 'plan-1',
      domain: 'inference',
      baseRevision: 4,
      schemaVersion: 1,
      descriptorHash: 'descriptor',
      dependencyRevisions: {},
      patch: [{ op: 'replace', path: '/credential', value: SECRET }],
      candidateHash: 'candidate-hash',
      candidate: { credential: SECRET },
      affectedPaths: ['/credential'],
      impacts: [],
      validation: { valid: true, issues: [] },
      probes: [],
      createdAt: '2026-08-11T00:00:00.000Z',
      expiresAt: '2026-08-11T00:05:00.000Z',
    };

    const projected = projectConfigPlan(plan);
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    expect(projected).not.toHaveProperty('candidate');
    expect(projected).not.toHaveProperty('patch');
  });

  it('uses the submitted inference document without hidden credential restoration', () => {
    const existing = {
      baseUrl: 'https://example.test',
      auth: { kind: 'aws', accessKeyId: 'key-id', secretAccessKey: SECRET, sessionToken: 'session' },
      headers: { Authorization: SECRET },
      proxyId: null,
    };
    const submitted = {
      baseUrl: 'https://next.test',
      auth: {
        kind: 'aws',
        accessKeyId: 'key-id',
        region: 'us-east-1',
        secretAccessKey: 'replacement',
      },
      headers: { Authorization: 'replacement-header' },
      proxyId: null,
    };

    expect(restoreConfigurationWrite('inference', submitted, existing)).toBe(submitted);
  });

});
