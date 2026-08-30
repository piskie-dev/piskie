import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';

import type { MarketEntry } from '@shared/types/market';

vi.mock('../../../components/shared', async () => {
  const { createElement: makeElement } = await import('react');
  return {
    CapabilityTag: () => makeElement('span'),
    ListItemCard: ({ children }: { children?: ReactNode }) => makeElement('div', null, children),
    StatusBadge: ({ children }: { children?: ReactNode }) => makeElement('span', null, children),
  };
});

import CapabilityListItem from '../CapabilityListItem';

function entry(overrides: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: 'openai-plugins:plugin:actively',
    kind: 'plugin',
    name: 'actively',
    description: 'Account agents for GTM intelligence',
    sourceId: 'openai-plugins',
    sourceName: 'OpenAI Plugins',
    sourceUrl: 'https://github.com/openai/plugins.git',
    installSource: '/tmp/actively',
    ...overrides,
  };
}

function renderCapability(entryValue: MarketEntry): string {
  return renderToStaticMarkup(createElement(CapabilityListItem, {
    entry: entryValue,
    selected: false,
    busy: false,
    onSelect: vi.fn(),
    onInstall: vi.fn(),
    onManage: vi.fn(),
  }));
}

describe('CapabilityListItem', () => {
  it('disables unsupported plugin installation and exposes the reason', () => {
    const reason = '此宿主插件没有可投影为 Piskie Skills 或普通 MCP 的成员';
    const markup = renderCapability(entry({
      installable: false,
      installDisabledReason: reason,
    }));

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(`title="${reason}"`);
    expect(markup).toContain('>不支持</button>');
  });

  it('keeps an installable plugin action enabled', () => {
    const markup = renderCapability(entry({ installable: true }));

    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('>安装</button>');
  });
});
