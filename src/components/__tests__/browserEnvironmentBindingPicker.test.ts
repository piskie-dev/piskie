import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BrowserEnvironmentBindingPicker from '../BrowserEnvironmentBindingPicker';
import { useBrowserEnvironmentStore } from '../../store/browserEnvironmentStore';

describe('BrowserEnvironmentBindingPicker slot', () => {
  beforeEach(() => {
    useBrowserEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
    });
  });

  it('renders the browser entry without any phone-selection content', () => {
    const markup = renderToStaticMarkup(React.createElement(BrowserEnvironmentBindingPicker, {
      value: [],
      onChange: vi.fn(),
      compact: true,
    }));

    expect(markup).toContain('选择浏览器…');
    expect(markup).not.toContain('选择手机');
  });
});
