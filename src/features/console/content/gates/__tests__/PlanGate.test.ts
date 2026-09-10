import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanGate, type PlanGateProps } from '../PlanGate';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
const onDecide = vi.fn();

function render(autoApproveAt?: number, disabled = false): void {
  const request: PlanGateProps['request'] = {
    kind: 'plan', taskSummary: 'Sample plan',
    call: {
      id: 'plan-a', agentId: 'agent-a', mainAgentId: 'agent-a', toolName: 'plan',
      params: { action: 'create' }, timestamp: new Date(), description: 'Review the plan',
      category: 'system', modeInvariant: true, autoApproveAt,
    },
  };
  act(() => root.render(React.createElement(PlanGate, { request, disabled, onDecide })));
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  onDecide.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('plan review countdown display', () => {
  it('keeps showing the same deadline after navigating away and back', () => {
    const deadline = Date.now() + 60_000;
    render(deadline);
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('60');
    act(() => vi.advanceTimersByTime(20_000));
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('40');
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(15_000));
    render(deadline);
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('25');
  });

  it('hides the countdown when confirmation is required or the gate is disabled', () => {
    render();
    expect(container.querySelector('[role="timer"]')).toBeNull();
    render(Date.now() + 60_000, true);
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector('button')?.disabled).toBe(true);
  });

  it('allows immediate manual approval while the countdown is running', () => {
    render(Date.now() + 60_000);
    act(() => container.querySelector('button')!.click());
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ kind: 'allow', callId: 'plan-a', changeToAuto: false });
  });
});
