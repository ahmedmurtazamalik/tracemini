import {describe, expect, it} from 'vitest';
import {DEFAULT_TIMEZONE, formatInTimezone, normalizeTimezone, todayInTimezone} from '../apps/web/timezone.js';

describe('web timezone preferences', () => {
  it('defaults to Pakistan Standard Time while allowing UTC', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Karachi');
    expect(normalizeTimezone(null)).toBe('Asia/Karachi');
    expect(normalizeTimezone('UTC')).toBe('UTC');
  });

  it('uses the selected timezone for dates and displayed timestamps', () => {
    const instant = new Date('2026-08-23T21:00:00.000Z');
    expect(todayInTimezone('Asia/Karachi', instant)).toBe('2026-08-24');
    expect(todayInTimezone('UTC', instant)).toBe('2026-08-23');
    expect(formatInTimezone(instant, 'UTC')).toContain('2026');
  });
});
