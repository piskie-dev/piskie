import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { ScheduleView } from '@shared/types/schedules';
import { SlotGridView } from '../SlotGridView';
import type { SlotEntry, SlotGridModel } from '../slot-grid-model';

const WEEK_START = new Date(2026, 0, 5);

function scheduleView(scheduleId: string, name: string): ScheduleView {
  return {
    schedule: {
      scheduleId,
      name,
      enabled: true,
      trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      runIfMissed: false,
      action: { kind: 'new_run', launch: { kind: 'definition', definitionId: `definition-${scheduleId}` } },
      createdBy: { kind: 'user' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    state: { consecutiveFailures: 0 },
    nextRunAt: null,
  };
}

function cellsWith(entry: SlotEntry): readonly (readonly SlotEntry[])[] {
  return [[entry], [], [], [], [], [], []];
}

function gridModel(): SlotGridModel {
  const alphaAt = new Date(2026, 0, 5, 9);
  const betaAt = new Date(2026, 0, 5, 10);
  const alpha: SlotEntry = {
    kind: 'future', scheduleId: 'alpha', name: 'Task Alpha', at: alphaAt, once: false, paused: false,
  };
  const beta: SlotEntry = {
    kind: 'future', scheduleId: 'beta', name: 'Task Beta', at: betaAt, once: false, paused: false,
  };
  return {
    weekStart: WEEK_START,
    days: Array.from({ length: 7 }, (_, index) => ({
      date: new Date(2026, 0, 5 + index),
      isToday: false,
      isWeekend: index >= 5,
    })),
    band: [[], [], [], [], [], [], []],
    rows: [
      { minuteOfDay: 9 * 60, at: alphaAt, cells: cellsWith(alpha), count: 1 },
      { minuteOfDay: 10 * 60, at: betaAt, cells: cellsWith(beta), count: 1 },
    ],
    nowRowIndex: null,
    summaryByScheduleId: {
      alpha: { started: 0, failed: 0, skipped: 0, future: 1 },
      beta: { started: 0, failed: 0, skipped: 0, future: 1 },
    },
    summary: { started: 0, failed: 0, skipped: 0, future: 2 },
  };
}

function render(selectedId: string | null): Document {
  const markup = renderToStaticMarkup(createElement(SlotGridView, {
    model: gridModel(),
    items: [scheduleView('alpha', 'Task Alpha'), scheduleView('beta', 'Task Beta')],
    selectedId,
    now: new Date(2026, 0, 12),
    locale: 'en-US',
    onPick: vi.fn(),
  }));
  return new JSDOM(markup).window.document;
}

describe('SlotGridView selection context', () => {
  it('keeps every task visible and marks only the selected task for emphasis', () => {
    const document = render('alpha');
    const grid = document.querySelector('[role="grid"]');
    const events = [...document.querySelectorAll<HTMLButtonElement>('button[data-kind]')];

    expect(grid?.hasAttribute('data-filtering')).toBe(true);
    expect(grid?.hasAttribute('data-solo')).toBe(false);
    expect(events.map((event) => event.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Task Alpha'),
      expect.stringContaining('Task Beta'),
    ]));
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.textContent?.includes('Task Alpha'))?.hasAttribute('data-hl')).toBe(true);
    expect(events.find((event) => event.textContent?.includes('Task Beta'))?.hasAttribute('data-hl')).toBe(false);
  });

  it('shows all tasks without filtering when all tasks is selected', () => {
    const document = render(null);
    const grid = document.querySelector('[role="grid"]');
    const events = [...document.querySelectorAll<HTMLButtonElement>('button[data-kind]')];

    expect(grid?.hasAttribute('data-filtering')).toBe(false);
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.hasAttribute('data-hl'))).toBe(false);
  });
});
