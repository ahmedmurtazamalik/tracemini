import type {DB} from './db.js';
import {fixedOffsetMinutes} from './timezone.js';

export type ReportFormat = 'summary' | 'detailed';
export type ReportScheduleFrequency = 'DAILY' | 'WEEKDAYS' | 'SELECTED_DAYS';
export type ReportScheduleRule = {
  frequency: ReportScheduleFrequency;
  selectedDays: number[];
  localTime: string;
  timezone: string;
};

export function normalizeReportFormat(value: unknown): ReportFormat {
  return value === 'summary' ? 'summary' : 'detailed';
}

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  if (fixedOffsetMinutes(value) !== undefined) return true;
  try { new Intl.DateTimeFormat('en-US', {timeZone: value}).format(new Date()); return true; } catch { return false; }
}

export function validateScheduleRule(value: any): ReportScheduleRule {
  const frequency = value?.frequency as ReportScheduleFrequency;
  if (!['DAILY', 'WEEKDAYS', 'SELECTED_DAYS'].includes(frequency)) throw new Error('invalid schedule frequency');
  if (typeof value?.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime)) throw new Error('invalid local time');
  if (!validTimezone(value?.timezone)) throw new Error('invalid timezone');
  const rawDays: number[] = Array.isArray(value.selectedDays) ? value.selectedDays.map((day: unknown) => Number(day)) : [];
  const selectedDays = [...new Set<number>(rawDays)].sort((a, b) => a - b);
  if (selectedDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('invalid selected weekdays');
  if (frequency === 'SELECTED_DAYS' && selectedDays.length === 0) throw new Error('choose at least one weekday');
  return {frequency, selectedDays: frequency === 'SELECTED_DAYS' ? selectedDays : [], localTime: value.localTime, timezone: value.timezone};
}

function zonedParts(instant: Date, timezone: string) {
  const fixed = fixedOffsetMinutes(timezone);
  if (fixed !== undefined) {
    const shifted = new Date(instant.getTime() + fixed * 60_000);
    return {year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes()};
  }
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)) if (part.type !== 'literal') values[part.type] = Number(part.value);
  return values as {year: number; month: number; day: number; hour: number; minute: number};
}

export function localDateKey(instant: Date, timezone: string) {
  const part = zonedParts(instant, timezone);
  return `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`;
}

export function resolveLocalDateTime(localDate: string, localTime: string, timezone: string) {
  if (!validTimezone(timezone)) throw new Error('invalid timezone');
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const time = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!date || !time) throw new Error('invalid local date or time');
  const [year, month, day, hour, minute] = [Number(date[1]), Number(date[2]), Number(date[3]), Number(time[1]), Number(time[2])];
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  const fixed = fixedOffsetMinutes(timezone);
  if (fixed !== undefined) return new Date(nominal - fixed * 60_000);
  const desiredMinute = hour * 60 + minute;
  let shifted: {instant: number; localMinute: number} | undefined;
  let afterGap: number | undefined;
  const requestedDate = `${date[1]}-${date[2]}-${date[3]}`;
  for (let instant = nominal - 18 * 60 * 60_000; instant <= nominal + 48 * 60 * 60_000; instant += 60_000) {
    const local = zonedParts(new Date(instant), timezone);
    const localDate = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
    if (localDate > requestedDate && afterGap === undefined) afterGap = instant;
    if (local.year !== year || local.month !== month || local.day !== day) continue;
    const localMinute = local.hour * 60 + local.minute;
    if (localMinute === desiredMinute) return new Date(instant);
    if (localMinute > desiredMinute && (!shifted || localMinute < shifted.localMinute || (localMinute === shifted.localMinute && instant < shifted.instant))) shifted = {instant, localMinute};
  }
  if (shifted) return new Date(shifted.instant);
  if (afterGap !== undefined) return new Date(afterGap);
  throw new Error('local schedule time cannot be resolved');
}

function scheduledWeekday(rule: ReportScheduleRule, weekday: number) {
  return rule.frequency === 'DAILY' || (rule.frequency === 'WEEKDAYS' && weekday <= 5) || (rule.frequency === 'SELECTED_DAYS' && rule.selectedDays.includes(weekday));
}

export function nextScheduledRun(input: ReportScheduleRule, after: Date) {
  const rule = validateScheduleRule(input);
  if (!Number.isFinite(after.getTime())) throw new Error('invalid schedule evaluation time');
  const localDate = localDateKey(after, rule.timezone);
  const base = Date.parse(`${localDate}T00:00:00.000Z`);
  for (let offset = 0; offset <= 14; offset++) {
    const candidateDate = new Date(base + offset * 86_400_000);
    const weekday = ((candidateDate.getUTCDay() + 6) % 7) + 1;
    if (!scheduledWeekday(rule, weekday)) continue;
    const instant = resolveLocalDateTime(candidateDate.toISOString().slice(0, 10), rule.localTime, rule.timezone);
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new Error('next schedule run not found');
}

export function latestScheduledRun(input: ReportScheduleRule, at: Date) {
  const rule = validateScheduleRule(input);
  if (!Number.isFinite(at.getTime())) throw new Error('invalid schedule evaluation time');
  const localDate = localDateKey(at, rule.timezone);
  const base = Date.parse(`${localDate}T00:00:00.000Z`);
  for (let offset = 0; offset <= 14; offset++) {
    const candidateDate = new Date(base - offset * 86_400_000);
    const weekday = ((candidateDate.getUTCDay() + 6) % 7) + 1;
    if (!scheduledWeekday(rule, weekday)) continue;
    const instant = resolveLocalDateTime(candidateDate.toISOString().slice(0, 10), rule.localTime, rule.timezone);
    if (instant.getTime() <= at.getTime()) return instant;
  }
  throw new Error('latest schedule run not found');
}

export function coalescedRunCount(input: ReportScheduleRule, first: Date, latest: Date) {
  const rule = validateScheduleRule(input);
  let cursor = Date.parse(`${localDateKey(first, rule.timezone)}T00:00:00.000Z`);
  const finalDate = Date.parse(`${localDateKey(latest, rule.timezone)}T00:00:00.000Z`);
  let count = 0;
  for (let guard = 0; cursor < finalDate && guard < 100_000; guard++) {
    cursor += 86_400_000;
    const weekday = ((new Date(cursor).getUTCDay() + 6) % 7) + 1;
    if (scheduledWeekday(rule, weekday)) count += 1;
  }
  if (cursor < finalDate) throw new Error('schedule catch-up window is too large');
  return count;
}

function subtractDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function materializeDueReportSchedules(db: DB, userId: number, at = new Date()) {
  const due = await db.prepare("SELECT s.id FROM report_schedules s JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=s.configured_by AND wm.role='Manager' WHERE s.configured_by=? AND s.enabled=TRUE AND s.next_run_at<=? ORDER BY s.next_run_at,s.id").all(userId, at.toISOString());
  let created = 0;
  for (const item of due) {
    created += await db.transaction(async () => {
      const scope: any = await db.prepare('SELECT workspace_id FROM report_schedules WHERE id=? AND configured_by=? AND enabled=TRUE AND next_run_at<=?').get(item.id, userId, at.toISOString());
      if (!scope) return 0;
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      if (!(await db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'").get(scope.workspace_id, userId))) return 0;
      const schedule: any = await db.prepare('SELECT * FROM report_schedules WHERE id=? AND configured_by=? AND enabled=TRUE AND next_run_at<=? FOR UPDATE').get(item.id, userId, at.toISOString());
      if (!schedule) return 0;
      const rule = validateScheduleRule({frequency: schedule.frequency, selectedDays: schedule.selected_days, localTime: schedule.local_time, timezone: schedule.timezone});
      const firstMissedRun = new Date(schedule.next_run_at);
      const scheduledFor = latestScheduledRun(rule, at);
      const coalescedRuns = coalescedRunCount(rule, firstMissedRun, scheduledFor);
      const endDate = subtractDays(localDateKey(scheduledFor, schedule.timezone), 1);
      const startDate = subtractDays(endDate, Number(schedule.window_days) - 1);
      const result = await db.prepare("INSERT INTO report_jobs(workspace_id,user_id,reporter,start_date,end_date,timezone,include_diff,notify_slack,status,report_name,format,report_scope,schedule_id,scheduled_for,coalesced_runs,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',? ,?,'workspace',?,?,?,?) ON CONFLICT (schedule_id,scheduled_for) DO NOTHING RETURNING id")
        .run(schedule.workspace_id, schedule.configured_by, schedule.reporter, startDate, endDate, schedule.timezone, schedule.include_diff, schedule.notify_slack, `Scheduled workspace report · ${startDate} — ${endDate}`, schedule.format, schedule.id, scheduledFor.toISOString(), coalescedRuns, at.toISOString());
      const nextRun = nextScheduledRun(rule, scheduledFor);
      await db.prepare('UPDATE report_schedules SET next_run_at=?,updated_at=? WHERE id=?').run(nextRun.toISOString(), at.toISOString(), schedule.id);
      return result.changes ? 1 : 0;
    });
  }
  return created;
}
