export const DEFAULT_TIMEZONE = 'Asia/Karachi';
export const TIMEZONE_OPTIONS = [
  {value: 'Asia/Karachi', label: 'Pakistan Standard Time (UTC+5)'},
  {value: 'UTC', label: 'UTC'},
] as const;

export function normalizeTimezone(value: string | null | undefined) {
  return value === 'UTC' ? 'UTC' : DEFAULT_TIMEZONE;
}

export function todayInTimezone(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function formatInTimezone(value: string | Date, timezone: string) {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: normalizeTimezone(timezone), dateStyle: 'medium', timeStyle: 'medium', hour12: true,
  }).format(new Date(value));
}
