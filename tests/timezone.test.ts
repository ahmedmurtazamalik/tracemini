import {describe, expect, it} from 'vitest';
import {dateKeyInTimezone, dateRangeUtc, normalizeTimezone} from '../apps/server/src/timezone.js';

describe('workspace timezone boundaries', () => {
  it('defaults to Pakistan Standard Time and supports UTC explicitly', () => {
    expect(normalizeTimezone(undefined)).toBe('Asia/Karachi');
    expect(normalizeTimezone('Asia/Karachi')).toBe('Asia/Karachi');
    expect(normalizeTimezone('UTC')).toBe('UTC');
    expect(normalizeTimezone('America/Los_Angeles')).toBe('Asia/Karachi');
  });

  it('converts Pakistan calendar days to exact UTC query bounds', () => {
    expect(dateRangeUtc('2026-08-24', '2026-08-24', 'Asia/Karachi')).toEqual({
      from: '2026-08-23T19:00:00.000Z',
      to: '2026-08-24T18:59:59.999Z',
    });
    expect(dateRangeUtc('2026-08-24', '2026-08-24', 'UTC')).toEqual({
      from: '2026-08-24T00:00:00.000Z',
      to: '2026-08-24T23:59:59.999Z',
    });
    expect(dateKeyInTimezone('2026-08-23T21:00:00.000Z', 'Asia/Karachi')).toBe('2026-08-24');
  });
});
