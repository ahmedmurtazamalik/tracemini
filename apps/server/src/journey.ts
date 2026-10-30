import type {DB} from './db.js';
import {activityBucketMinutes, dateKeyInTimezone, dateRangeUtc} from './timezone.js';

// Counts and work descriptions share one aggregate read. Generated Git subjects
// are excluded before MIN so they cannot displace substantive work in a bucket.
export async function developmentJourney(db: DB, workspaceId: number, timezone: string, now = new Date()) {
  const to = dateKeyInTimezone(now, timezone);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
  const bounds = dateRangeUtc(from, to, timezone);
  const bucketMinutes = activityBucketMinutes(timezone);
  const [people, clones, events] = await Promise.all([
    db.prepare('SELECT u.id,u.name FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? ORDER BY u.name').all(workspaceId),
    db.prepare(`SELECT DISTINCT r.id,r.name,r.archived,a.user_id FROM repositories r
      LEFT JOIN local_clones c ON c.repository_id=r.id LEFT JOIN agents a ON a.id=c.agent_id
      WHERE r.workspace_id=? ORDER BY r.name`).all(workspaceId),
    db.prepare(`SELECT e.user_id,u.name user_name,r.id repository_id,e.type,
      date_bin('${bucketMinutes} minutes',e.occurred_at,TIMESTAMPTZ '1970-01-01 00:00:00+00') occurred_hour,COUNT(*)::INTEGER event_count,
      MAX(e.occurred_at) last_activity_at,
      MIN(CASE WHEN e.type='commit' AND e.data::JSONB->>'message' !~* '^[[:space:]]*(merge (pull request|branch|remote-tracking branch|tag)\\y|(wip on|on|index on|untracked files on) [^:]+:|stash\\y|fixup!|squash!)'
        THEN LEFT(e.data::JSONB->>'message',180) END) preview
      FROM activity_events e JOIN activity_event_repositories aer ON aer.event_id=e.id
      JOIN repositories r ON r.id=aer.repository_id JOIN users u ON u.id=e.user_id
      WHERE r.workspace_id=? AND e.occurred_at>=? AND e.occurred_at<=?
      GROUP BY e.user_id,u.name,r.id,e.type,date_bin('${bucketMinutes} minutes',e.occurred_at,TIMESTAMPTZ '1970-01-01 00:00:00+00')
      ORDER BY occurred_hour DESC`).all(workspaceId, bounds.from, bounds.to),
  ]);
  const members = new Map(people.map((person: any) => [Number(person.id), {id: Number(person.id), name: String(person.name)}]));
  const repositories = new Map<number, {id: number; name: string; archived: boolean; userIds: number[]}>();
  for (const row of clones as any[]) {
    const id = Number(row.id);
    const repository = repositories.get(id) || {id, name: String(row.name), archived: Boolean(row.archived), userIds: []};
    if (row.user_id != null && !repository.userIds.includes(Number(row.user_id))) repository.userIds.push(Number(row.user_id));
    repositories.set(id, repository);
  }
  const dates = new Map<string, string>();
  type Preview = {repositoryId: number; type: string; text: string; at: string};
  const days = new Map<string, {userId: number; repositoryId: number; date: string; counts: Record<string, number>; total: number; lastActivityAt: string; previews: Preview[]}>();
  for (const row of events as any[]) {
    const hour = new Date(row.occurred_hour).toISOString();
    const date = dates.get(hour) || dateKeyInTimezone(hour, timezone);
    dates.set(hour, date);
    const userId = Number(row.user_id), repositoryId = Number(row.repository_id);
    // Retain historical activity when someone has since left the workspace.
    if (!members.has(userId)) members.set(userId, {id: userId, name: String(row.user_name)});
    const key = `${userId}:${repositoryId}:${date}`;
    const lastActivityAt = new Date(row.last_activity_at).toISOString();
    const day = days.get(key) || {userId, repositoryId, date, counts: {}, total: 0, lastActivityAt, previews: []};
    if (lastActivityAt > day.lastActivityAt) day.lastActivityAt = lastActivityAt;
    day.counts[row.type] = (day.counts[row.type] || 0) + Number(row.event_count);
    day.total += Number(row.event_count);
    const text = String(row.preview || '').split(/\r?\n/, 1)[0].trim();
    if (text && !day.previews.some(preview => preview.type === row.type && preview.text === text)) {
      day.previews.push({repositoryId, type: row.type, text, at: lastActivityAt});
      day.previews.sort((a, b) => Number(b.type === 'commit') - Number(a.type === 'commit') || b.at.localeCompare(a.at) || a.text.localeCompare(b.text));
      day.previews.length = Math.min(2, day.previews.length);
    }
    days.set(key, day);
  }
  return {from, to, timezone, people: [...members.values()], repositories: [...repositories.values()], days: [...days.values()]};
}
