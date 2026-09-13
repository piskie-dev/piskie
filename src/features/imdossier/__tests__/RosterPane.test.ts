import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  connectorDescriptors: [],
  connections: [{ config: { id: 'orphan', name: 'Saved Bot', channelType: 'missing-channel' }, status: 'stopped' }],
  senderAuthorizationRequests: [], isLoadingConnectors: false, isLoadingConnections: false,
  fetchConnectorDescriptors: vi.fn(), fetchConnections: vi.fn(),
}));
vi.mock('../../../store/messagingStore', () => ({
  useMessagingStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('../../../renderer-runtime/hooks', () => ({
  useTaskDefinitionRepository: () => [],
}));
vi.mock('../HandbookPopover', () => ({ HandbookPopover: () => null }));
vi.mock('../PendingPopover', () => ({ PendingPopover: () => null }));
import { RosterPane } from '../RosterPane';

describe('IM roster when the connector catalog is unavailable', () => {
  it.each([false, true])('keeps saved Bots reachable while loading=%s', (isLoading) => {
    state.isLoadingConnectors = isLoading;
    const html = renderToStaticMarkup(createElement(RosterPane, {
      pickedBotId: null, onPick: vi.fn(), onDraft: vi.fn(),
      pageGuide: { consoleURL: '', steps: [] },
    }));
    expect(html).toContain('Saved Bot');
    expect(html).toContain('role="button"');
  });
});
