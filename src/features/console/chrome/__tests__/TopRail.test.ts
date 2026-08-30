import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { TopRail } from '../TopRail';

function renderRail(withActions: boolean): HTMLElement {
  const markup = renderToStaticMarkup(
    createElement(
      TopRail,
      withActions
        ? { actions: createElement('button', { 'data-testid': 'action' }, 'Action') }
        : {},
      createElement('nav', { 'data-testid': 'navigation' }, 'Navigation'),
    ),
  );
  const dom = new JSDOM(`<body>${markup}</body>`);
  const rail = dom.window.document.body.firstElementChild;
  if (!rail) throw new Error('TopRail did not render');
  return rail as HTMLElement;
}

describe('TopRail', () => {
  it('places navigation and actions in separate layout tracks', () => {
    const rail = renderRail(true);

    expect(rail.dataset.hasActions).toBe('true');
    expect(rail.children).toHaveLength(2);
    expect(rail.children[0]?.querySelector('[data-testid="navigation"]')).not.toBeNull();
    expect(rail.children[1]?.querySelector('[data-testid="action"]')).not.toBeNull();
  });

  it('does not reserve an action track when no actions are present', () => {
    const rail = renderRail(false);

    expect(rail.dataset.hasActions).toBeUndefined();
    expect(rail.children).toHaveLength(1);
  });
});
