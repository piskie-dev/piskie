import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleView } from '@shared/types/schedules';
import { ScheduleDirectory } from '../ScheduleDirectory';

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function scheduleView(
  scheduleId = 'schedule-1',
  state: Partial<ScheduleView['state']> = {},
): ScheduleView {
  return {
    schedule: {
      scheduleId,
      name: 'Weekly review',
      enabled: true,
      trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'UTC' },
      runIfMissed: false,
      action: { kind: 'new_run', launch: { kind: 'definition', definitionId: 'definition-1' } },
      createdBy: { kind: 'user' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    state: { consecutiveFailures: 0, ...state },
    nextRunAt: state.firedAt ? null : '2026-01-05T09:00:00.000Z',
  };
}

describe('ScheduleDirectory', () => {
  it('exposes a separate row delete action without selecting the schedule', async () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();

    await act(async () => {
      root.render(createElement(ScheduleDirectory, {
        items: [scheduleView()],
        definitions: [],
        now: new Date('2026-01-01T00:00:00.000Z'),
        locale: 'en-US',
        selectedId: null,
        query: '',
        loading: false,
        busy: false,
        onQuery: vi.fn(),
        onSelect,
        onDelete,
        onCreate: vi.fn(),
        onRefresh: vi.fn(),
      }));
    });

    const deleteButton = container.querySelector('.lucide-trash-2')?.closest('button');
    expect(deleteButton).toBeTruthy();
    expect(deleteButton?.parentElement?.querySelectorAll(':scope > button')).toHaveLength(2);

    await act(async () => deleteButton?.click());

    expect(onDelete).toHaveBeenCalledWith('schedule-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('collapses the active and fired groups independently', async () => {
    await act(async () => {
      root.render(createElement(ScheduleDirectory, {
        items: [
          scheduleView('active-schedule'),
          scheduleView('fired-schedule', { firedAt: '2026-01-01T09:00:00.000Z' }),
        ],
        definitions: [],
        now: new Date('2026-01-01T10:00:00.000Z'),
        locale: 'en-US',
        selectedId: null,
        query: '',
        loading: false,
        busy: false,
        onQuery: vi.fn(),
        onSelect: vi.fn(),
        onDelete: vi.fn(),
        onCreate: vi.fn(),
        onRefresh: vi.fn(),
      }));
    });

    const activeToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="schedule-directory-group-active"]',
    );
    const firedToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="schedule-directory-group-fired"]',
    );
    const activeItems = container.querySelector<HTMLElement>('#schedule-directory-group-active');
    const firedItems = container.querySelector<HTMLElement>('#schedule-directory-group-fired');

    expect(activeToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(firedToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(activeItems?.hidden).toBe(false);
    expect(firedItems?.hidden).toBe(false);

    await act(async () => activeToggle?.click());

    expect(activeToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(activeItems?.hidden).toBe(true);
    expect(firedToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(firedItems?.hidden).toBe(false);

    await act(async () => firedToggle?.click());

    expect(firedToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(firedItems?.hidden).toBe(true);
  });
});
