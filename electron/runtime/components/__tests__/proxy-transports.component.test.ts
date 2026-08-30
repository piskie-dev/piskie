import { afterEach, describe, expect, it } from 'vitest';
import { publishProxyPoolSnapshot } from '../../../core/storage/proxy-config-store.js';
import {
  closeConfiguredProxyTransports,
  configuredProxyTransportLifecycleSnapshot,
  requireConfiguredProxyDispatcher,
} from '../../../core/proxy/proxy-resolver.js';
import { ResourceLedger } from '../../lifecycle/resource-ledger.js';
import { ResourceScope } from '../../lifecycle/resource-scope.js';
import { createProxyTransportsComponent } from '../proxy-transports.component.js';

afterEach(async () => {
  publishProxyPoolSnapshot({ proxies: [] });
  await closeConfiguredProxyTransports();
});

describe('proxy-transports runtime component', () => {
  it('owns configured Node transports below inference and MCP', async () => {
    const component = createProxyTransportsComponent();
    const controller = new AbortController();
    const scope = new ResourceScope(
      'proxy-generation',
      'component:proxy-transports',
      new ResourceLedger('proxy-generation'),
    );
    await component.start({
      generation: 'proxy-generation',
      startedAt: Date.now(),
      signal: controller.signal,
    }, scope);
    publishProxyPoolSnapshot({ proxies: [{
      id: 'proxy-one',
      name: 'Proxy one',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      enabled: true,
    }] });
    requireConfiguredProxyDispatcher('proxy-one');
    expect(configuredProxyTransportLifecycleSnapshot().dispatchers).toBe(1);
    expect(component.dependsOn).toEqual(['storage']);

    await component.stop({
      generation: 'proxy-generation',
      reason: 'test-complete',
      deadlineAt: Date.now() + 1_000,
      signal: controller.signal,
    }, undefined);

    expect(configuredProxyTransportLifecycleSnapshot()).toEqual({
      agents: 0,
      dispatchers: 0,
      retiringDispatchers: 0,
    });
    await expect(component.verifyStopped({ generation: 'proxy-generation' }))
      .resolves.toMatchObject({ state: 'stopped' });
    await scope.close('test-complete');
  });
});
