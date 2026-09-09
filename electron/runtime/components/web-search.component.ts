import type { SearchService } from '../../search/service.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createWebSearchComponent(service: SearchService): RuntimeComponent<SearchService> {
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= service.close().then(() => { closed = true; });
  return {
    id: 'web-search', requirement: 'required', dependsOn: ['proxy-transports'],
    async start(_context, scope) {
      scope.register({ kind: 'custom', label: 'web-search-service', close,
        inspect: () => closed ? 'closed' : 'live' });
      return service;
    },
    stop: close,
    async verifyStopped() { return { state: closed ? 'stopped' : 'live' }; },
  };
}
