import { JSDOM } from 'jsdom';
import { act, createElement, Fragment, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PiskieUpdateStatus, UpdateClient } from '@shared/electron-contracts/updates';
import { useUpdateStatus } from '../useUpdateStatus';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let mounted = false;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('SVGElement', dom.window.SVGElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('useUpdateStatus', () => {
  it('shares one status subscription, applies its initial snapshot, and cleans up last', async () => {
    let emit: ((status: PiskieUpdateStatus) => void) | undefined;
    const unsubscribe = vi.fn();
    const initialStatus: PiskieUpdateStatus = { state: 'idle', currentVersion: '0.1.0' };
    const client: UpdateClient = {
      status: vi.fn(async () => initialStatus),
      check: vi.fn(async () => initialStatus),
      restartAndInstall: vi.fn(async () => true),
      observeStatus: vi.fn((listener) => {
        emit = listener;
        return unsubscribe;
      }),
    };
    Object.defineProperty(dom.window, 'piskie', {
      configurable: true,
      value: { updates: client, runtime: { version: '0.1.0' } },
    });

    await render(true);
    expect(client.observeStatus).toHaveBeenCalledOnce();
    expect(client.status).toHaveBeenCalledOnce();
    expect(container.textContent?.trim()).toBe('first:idle second:idle');

    await act(async () => emit?.({
      state: 'downloaded',
      currentVersion: '0.1.0',
      target: { version: '0.2.0' },
    }));
    expect(container.textContent?.trim()).toBe('first:downloaded second:downloaded');

    await render(false);
    expect(unsubscribe).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    mounted = false;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

const Consumer = ({ name }: { name: string }): ReactElement => {
  const status = useUpdateStatus();
  return createElement('span', null, `${name}:${status?.state ?? 'loading'} `);
};

async function render(second: boolean): Promise<void> {
  await act(async () => root.render(
    createElement(
      Fragment,
      null,
      createElement(Consumer, { name: 'first' }),
      second ? createElement(Consumer, { name: 'second' }) : null,
    ),
  ));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
