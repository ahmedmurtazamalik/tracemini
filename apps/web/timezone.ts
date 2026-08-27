export const DEFAULT_TIMEZONE = 'Asia/Karachi';

export function fixedOffsetMinutes(value: unknown) {
  if (value === 'UTC') return 0;
  if (typeof value !== 'string') return undefined;
  const match = /^UTC([+-])(\d{2}):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
  return minutes >= -12 * 60 && minutes <= 14 * 60 ? minutes : undefined;
}

const fixedOffsetValues = [...new Set([
  ...Array.from({length: 27}, (_, index) => (index - 12) * 60),
  -570, -270, -210, 210, 270, 330, 345, 390, 525, 570, 630, 765, 825,
])].sort((left, right) => left - right);

function offsetValueFromMinutes(minutes: number) {
  if (minutes === 0) return 'UTC';
  const absolute = Math.abs(minutes);
  return `UTC${minutes > 0 ? '+' : '-'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function timezoneOffsetInput(timezone: string, now = new Date()) {
  const normalized = normalizeTimezone(timezone);
  const fixed = fixedOffsetMinutes(normalized);
  let minutes = fixed;
  if (minutes === undefined) {
    const name = new Intl.DateTimeFormat('en-US', {timeZone: normalized, timeZoneName: 'longOffset'})
      .formatToParts(now).find(part => part.type === 'timeZoneName')?.value || 'GMT';
    const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2}))?$/.exec(name);
    minutes = match?.groups?.sign
      ? (Number(match.groups.hours) * 60 + Number(match.groups.minutes)) * (match.groups.sign === '+' ? 1 : -1)
      : 0;
  }
  const absolute = Math.abs(minutes);
  return `${minutes >= 0 ? '+' : '-'}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, '0')}`;
}

export function timezoneFromOffsetInput(value: string) {
  const match = /^([+-]?)(\d{1,2})(?::([0-5]\d))?$/.exec(value.trim());
  if (!match) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  const minutes = sign * (Number(match[2]) * 60 + Number(match[3] || 0));
  if (minutes < -12 * 60 || minutes > 14 * 60) return undefined;
  if ((minutes === -12 * 60 || minutes === 14 * 60) && Number(match[3] || 0) !== 0) return undefined;
  return offsetValueFromMinutes(minutes);
}

export function hourInTimezone(timezone: string, now = new Date()) {
  const normalized = normalizeTimezone(timezone);
  const offset = fixedOffsetMinutes(normalized);
  if (offset !== undefined) return new Date(now.getTime() + offset * 60_000).getUTCHours();
  return Number(new Intl.DateTimeFormat('en-US', {timeZone: normalized, hour: '2-digit', hourCycle: 'h23'}).format(now));
}

export const TIMEZONE_OPTIONS = [
  {value: 'Asia/Karachi', label: 'Pakistan Standard Time (UTC+05:00)'},
  ...fixedOffsetValues.map(minutes => ({value: offsetValueFromMinutes(minutes), label: offsetValueFromMinutes(minutes)})),
];

export function normalizeTimezone(value: string | null | undefined) {
  if (typeof value !== 'string') return DEFAULT_TIMEZONE;
  if (fixedOffsetMinutes(value) !== undefined) return value;
  try { new Intl.DateTimeFormat('en-US', {timeZone: value}).format(new Date(0)); return value; }
  catch { return DEFAULT_TIMEZONE; }
}

export function todayInTimezone(timezone: string, now = new Date()) {
  const normalized = normalizeTimezone(timezone);
  const offset = fixedOffsetMinutes(normalized);
  if (offset !== undefined) return new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalized, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function formatInTimezone(value: string | Date, timezone: string) {
  const normalized = normalizeTimezone(timezone);
  const offset = fixedOffsetMinutes(normalized);
  const instant = new Date(value);
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: offset === undefined ? normalized : 'UTC', dateStyle: 'medium', timeStyle: 'medium', hour12: true,
  }).format(offset === undefined ? instant : new Date(instant.getTime() + offset * 60_000));
}
