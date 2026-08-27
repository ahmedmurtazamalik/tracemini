export const DEFAULT_TIMEZONE = 'Asia/Karachi';
export type SupportedTimezone = string;

export function fixedOffsetMinutes(value: unknown) {
  if (value === 'UTC') return 0;
  if (typeof value !== 'string') return undefined;
  const match = /^UTC([+-])(\d{2}):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
  return minutes >= -12 * 60 && minutes <= 14 * 60 ? minutes : undefined;
}

export function activityBucketMinutes(timezone: SupportedTimezone) {
  const fixed = fixedOffsetMinutes(timezone);
  return fixed !== undefined && Math.abs(fixed) % 15 !== 0 ? 1 : 15;
}

export function normalizeTimezone(value: unknown): SupportedTimezone {
  if (typeof value !== 'string') return DEFAULT_TIMEZONE;
  if (fixedOffsetMinutes(value) !== undefined) return value;
  try { new Intl.DateTimeFormat('en-US', {timeZone: value}).format(new Date(0)); return value; }
  catch { return DEFAULT_TIMEZONE; }
}

function zonedParts(instant: Date, timezone: SupportedTimezone) {
  const fixed = fixedOffsetMinutes(timezone);
  if (fixed !== undefined) {
    const shifted = new Date(instant.getTime() + fixed * 60_000);
    return {year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes()};
  }
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values as {year: number; month: number; day: number; hour: number; minute: number};
}

function localMidnightUtc(date: string, timezone: SupportedTimezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('invalid date');
  const nominal = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const fixed = fixedOffsetMinutes(timezone);
  if (fixed !== undefined) return nominal - fixed * 60_000;
  let low = nominal - 36 * 60 * 60_000;
  let high = nominal + 36 * 60 * 60_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const local = zonedParts(new Date(middle), timezone);
    const localDate = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
    if (localDate < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function dateRangeUtc(from: string, to: string, timezone: SupportedTimezone) {
  const normalized = normalizeTimezone(timezone);
  const nextDay = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    from: new Date(localMidnightUtc(from, normalized)).toISOString(),
    to: new Date(localMidnightUtc(nextDay, normalized) - 1).toISOString(),
  };
}

export function dateKeyInTimezone(value: string | Date, timezone: SupportedTimezone) {
  const part = zonedParts(new Date(value), normalizeTimezone(timezone));
  return `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`;
}

export function hourInTimezone(value: string | Date, timezone: SupportedTimezone) {
  return zonedParts(new Date(value), normalizeTimezone(timezone)).hour;
}
