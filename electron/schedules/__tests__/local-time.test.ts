import { describe, expect, it } from 'vitest';
import { formatLocalDateTime, isValidTimeZone, parseLocalDateTime } from '../local-time.js';

describe('parseLocalDateTime', () => {
  it('interprets offset-less input as wall clock time in the given timezone', () => {
    expect(parseLocalDateTime('2026-09-18T09:00', 'Asia/Shanghai')?.toISOString())
      .toBe('2026-09-18T01:00:00.000Z');
    expect(parseLocalDateTime('2026-09-18 09:00:30', 'Asia/Shanghai')?.toISOString())
      .toBe('2026-09-18T01:00:30.000Z');
    expect(parseLocalDateTime('2026-09-18', 'Asia/Shanghai')?.toISOString())
      .toBe('2026-09-17T16:00:00.000Z');
  });

  it('respects daylight saving of the timezone', () => {
    expect(parseLocalDateTime('2026-07-01T09:00', 'America/New_York')?.toISOString())
      .toBe('2026-07-01T13:00:00.000Z');
    expect(parseLocalDateTime('2026-12-01T09:00', 'America/New_York')?.toISOString())
      .toBe('2026-12-01T14:00:00.000Z');
  });

  it('keeps explicit offsets and rejects garbage', () => {
    expect(parseLocalDateTime('2026-09-18T09:00+08:00', 'UTC')?.toISOString())
      .toBe('2026-09-18T01:00:00.000Z');
    expect(parseLocalDateTime('2026-09-18T01:00:00Z', 'Asia/Shanghai')?.toISOString())
      .toBe('2026-09-18T01:00:00.000Z');
    expect(parseLocalDateTime('tomorrow morning', 'UTC')).toBeNull();
    expect(parseLocalDateTime('2026-13-45T09:00', 'UTC')).toBeNull();
  });
});

describe('formatLocalDateTime', () => {
  it('prints wall clock time with a 24-hour clock', () => {
    expect(formatLocalDateTime(new Date('2026-09-18T01:00:00Z'), 'Asia/Shanghai')).toBe('2026-09-18 09:00');
    expect(formatLocalDateTime(new Date('2026-09-17T16:00:00Z'), 'Asia/Shanghai')).toBe('2026-09-18 00:00');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects unknown ones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Nowhere/Land')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
