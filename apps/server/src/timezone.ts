export const DEFAULT_TIMEZONE = 'Asia/Karachi';
export const SUPPORTED_TIMEZONES = ['Asia/Karachi', 'UTC'] as const;
export type SupportedTimezone = typeof SUPPORTED_TIMEZONES[number];

export function normalizeTimezone(value: unknown): SupportedTimezone {
  return value === 'UTC' ? 'UTC' : DEFAULT_TIMEZONE;
}

function offsetMs(timezone: SupportedTimezone) {
  return timezone === 'Asia/Karachi' ? 5 * 60 * 60_000 : 0;
}

function utcMidnight(date: string) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function dateRangeUtc(from: string, to: string, timezone: SupportedTimezone) {
  const offset = offsetMs(timezone);
  return {
    from: new Date(utcMidnight(from) - offset).toISOString(),
    to: new Date(utcMidnight(to) + 24 * 60 * 60_000 - offset - 1).toISOString(),
  };
}

export function dateKeyInTimezone(value: string | Date, timezone: SupportedTimezone) {
  return new Date(new Date(value).getTime() + offsetMs(timezone)).toISOString().slice(0, 10);
}
