import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Panel, type PanelProps } from '../Panel';

type TestPanelProps = Omit<PanelProps, 'children'> & { readonly children?: ReactNode };
const TestPanel = Panel as unknown as ComponentType<TestPanelProps>;

describe('Panel bottom bands', () => {
  it('orders runtime and the shared task list before gate and persistent footer metrics', () => {
    const html = renderToStaticMarkup(createElement(
      TestPanel,
      {
        title: 'Agent',
        runtime: createElement('div', null, 'runtime status'),
        taskList: createElement('div', null, 'shared task list'),
        gate: createElement('div', null, 'approval gate'),
        footer: createElement('div', null, 'run metrics'),
      },
      createElement('div', null, 'transcript'),
    ));

    expect(html).toContain('approval gate');
    expect(html).toContain('run metrics');
    expect(html.indexOf('transcript')).toBeLessThan(html.indexOf('runtime status'));
    expect(html.indexOf('runtime status')).toBeLessThan(html.indexOf('shared task list'));
    expect(html.indexOf('shared task list')).toBeLessThan(html.indexOf('approval gate'));
    expect(html.indexOf('approval gate')).toBeLessThan(html.indexOf('run metrics'));
  });
});
