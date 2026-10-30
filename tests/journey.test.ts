import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {dateKeyInTimezone, dateRangeUtc} from '../apps/server/src/timezone.js';
import {journeyChains, journeyDates, type JourneyData} from '../apps/web/journey-data.js';
import type {DB} from '../apps/server/src/db.js';

let db: DB | undefined;
afterEach(async () => { await db?.close(); db = undefined; });
const auth = (token: string) => ({authorization: `Bearer ${token}`});

describe('development journey', () => {
  it('groups observed projects per member without mixing contributors or losing quiet tracked projects', () => {
    const data: JourneyData = {
      from: '2026-10-17', to: '2026-10-30', timezone: 'UTC',
      people: [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}],
      repositories: [{id: 10, name: 'App', archived: false, userIds: [1, 2]}, {id: 11, name: 'Quiet', archived: false, userIds: [1]}, {id: 12, name: 'Archived', archived: true, userIds: [1]}],
      days: [
        {userId: 1, repositoryId: 10, date: '2026-10-29', total: 2, counts: {commit: 2}, previews: [{repositoryId: 10, type: 'commit', text: 'Fix sign-in validation', at: '2026-10-29T10:00:00Z'}]},
        {userId: 2, repositoryId: 10, date: '2026-10-29', total: 3, counts: {commit: 1, push: 2}},
        {userId: 1, repositoryId: 12, date: '2026-10-18', total: 1, counts: {stage: 1}},
        {userId: 1, repositoryId: 12, date: '2026-10-29', total: 1, counts: {commit: 1}, previews: [{repositoryId: 12, type: 'commit', text: 'Update account navigation', at: '2026-10-29T11:00:00Z'}]},
      ],
    };
    const dates = journeyDates(data.from, data.to);
    expect(dates).toHaveLength(14);
    expect(dates.slice(7)).toHaveLength(7);
    expect(dates.at(-1)).toBe(data.to);
    const person = journeyChains(data, 1);
    expect(person.map(chain => chain.id)).toEqual([10, 11, 12]);
    expect(person[0].days.get('2026-10-29')).toEqual({total: 2, counts: {commit: 2}, previews: data.days[0].previews});
    expect(person[1].days.size).toBe(0);
    expect(journeyChains(data, 2).map(chain => chain.id)).toEqual([10]);
    expect(journeyChains(data, undefined, 10)[0].days.get('2026-10-29')).toEqual({total: 5, counts: {commit: 3, push: 2}, previews: data.days[0].previews});
    expect(journeyChains(data, 2, 12)[0].days.size).toBe(0);
    expect(data.days[0].total).toBe(2);
    const general = journeyChains(data, 1, undefined, true);
    expect(general).toHaveLength(1);
    expect(general[0]).toMatchObject({id: 0, name: 'All projects', projectCount: 3});
    expect(general[0].days.get('2026-10-29')).toEqual({total: 3, counts: {commit: 3}, previews: [data.days[3].previews![0], data.days[0].previews![0]]});
    expect(general[0].days.get('2026-10-18')).toEqual({total: 1, counts: {stage: 1}});
    expect(data.days[0].previews).toHaveLength(1);
  });

  it('serves complete fortnight counts and bounded, scoped evidence with timezone and membership boundaries', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@journey.test`, password: 'password123'}).expect(201)).body;
    const owner = await register('Owner');
    const outsider = await register('Outsider');
    const workspace = (await request(app).post('/api/workspaces').set(auth(owner.token)).send({name: 'Journey'}).expect(201)).body;
    const otherWorkspace = (await request(app).post('/api/workspaces').set(auth(outsider.token)).send({name: 'Private'}).expect(201)).body;
    const at = new Date().toISOString();
    const agent: any = await db.prepare('INSERT INTO agents(user_id,workspace_id,machine_name,token_hash,created_at) VALUES(?,?,?,?,?) RETURNING id').get(owner.user.id, workspace.id, 'test-device', 'test-agent-hash', at);
    const repository = async (workspaceId: number, name: string) => await db!.prepare('INSERT INTO repositories(workspace_id,name,remote_url,normalized_remote,created_at) VALUES(?,?,?,?,?) RETURNING id').get(workspaceId, name, `https://example.test/${name}`, name, at) as {id: number};
    const repo = await repository(workspace.id, '/private/local/App');
    const quiet = await repository(workspace.id, 'Quiet');
    const foreign = await repository(otherWorkspace.id, 'Foreign');
    await db.prepare('INSERT INTO local_clones(agent_id,repository_id,local_key,last_seen) VALUES(?,?,?,?)').run(agent.id, quiet.id, '/private/quiet', at);
    const timezone = 'UTC+05:20';
    const today = dateKeyInTimezone(at, timezone);
    const midnight = Date.parse(dateRangeUtc(today, today, timezone).from);
    const previous = dateKeyInTimezone(new Date(midnight - 1), timezone);
    const entries = Array.from({length: 501}, (_, index) => ({repo: repo.id, user: owner.user.id, type: index === 500 ? 'push' : 'commit', at: new Date(midnight + 60_000).toISOString()}));
    entries.push({repo: repo.id, user: owner.user.id, type: 'stage', at: new Date(midnight - 1).toISOString()});
    entries.push({repo: foreign.id, user: outsider.user.id, type: 'commit', at});
    entries.push({repo: repo.id, user: outsider.user.id, type: 'commit', at: new Date(midnight + 60_000).toISOString()});
    // Bulk insert only disposable test evidence; there is no application seed.
    const values: unknown[] = [];
    const tuples = entries.map((event, index) => {
      const start = values.length;
      values.push(`journey-${index}`, event.user, agent.id, event.repo, event.type, event.at,
        JSON.stringify({message: index === 0 ? 'Change 0 /private/source\nMore details' : event.type === 'stage' ? `Long ${'x'.repeat(300)}` : `Change ${index}`, branch: 'main', commitSha: String(index).padStart(40, 'a'), privatePath: '/private/source'}), at);
      return `(${Array.from({length: 8}, (_, offset) => `$${start + offset + 1}`).join(',')})`;
    });
    await db.query(`INSERT INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES ${tuples.join(',')}`, values);
    await db.query('INSERT INTO activity_event_repositories(event_id,repository_id) SELECT id,repository_id FROM activity_events');
    // Shared event links must stay in the destination workspace's scope.
    const linked: any = await db.prepare('SELECT id FROM activity_events WHERE event_key=?').get('journey-0');
    await db.prepare('INSERT INTO activity_event_repositories(event_id,repository_id) VALUES(?,?)').run(linked.id, foreign.id);

    const endpoint = `/api/workspaces/${workspace.id}/journey?timezone=${encodeURIComponent(timezone)}`;
    await request(app).get(endpoint).expect(401);
    await request(app).get(endpoint).set(auth(outsider.token)).expect(403);
    const summary: JourneyData = (await request(app).get(endpoint).set(auth(owner.token)).expect(200)).body;
    expect(journeyDates(summary.from, summary.to)).toHaveLength(14);
    expect(summary.timezone).toBe(timezone);
    expect(summary.days.find(day => day.userId === owner.user.id && day.repositoryId === repo.id && day.date === today)).toMatchObject({total: 501, counts: {commit: 500, push: 1}});
    expect(summary.days.find(day => day.date === previous)).toMatchObject({total: 1, counts: {stage: 1}});
    expect(summary.repositories).toContainEqual({id: quiet.id, name: 'Quiet', archived: false, userIds: [owner.user.id]});
    expect(summary.repositories.find(item => item.id === repo.id)?.name).toBe('App');
    expect(summary.repositories.some(item => item.id === foreign.id)).toBe(false);
    expect(summary.people.some(person => person.id === outsider.user.id)).toBe(true); // Historical contributor.
    expect(JSON.stringify(summary)).not.toMatch(/\/private\/|privatePath|"token"|"email"|More details/);
    const previewDay = summary.days.find(day => day.userId === owner.user.id && day.repositoryId === repo.id && day.date === today)!;
    expect(previewDay.previews).toHaveLength(2);
    expect(previewDay.previews![0]).toMatchObject({repositoryId: repo.id, type: 'commit', text: 'Change 0 [private local path]'});
    expect(summary.days.find(day => day.date === previous)?.previews![0].text).toHaveLength(160);

    const evidence = `/api/workspaces/${workspace.id}/activity?from=${today}&to=${today}&timezone=${encodeURIComponent(timezone)}&repositoryId=${repo.id}&userId=${owner.user.id}`;
    const details = (await request(app).get(evidence).set(auth(owner.token)).expect(200)).body;
    expect(details).toHaveLength(500);
    expect(details.every((event: any) => event.user_id === owner.user.id && event.repository_id === repo.id)).toBe(true);
    expect(details[0].data).toHaveProperty('message');
    expect(JSON.stringify(details)).not.toContain('/private/');
    expect((await request(app).get(evidence.replace(`repositoryId=${repo.id}`, `repositoryId=${foreign.id}`)).set(auth(owner.token)).expect(200)).body).toEqual([]);
    await request(app).get(evidence).set(auth(outsider.token)).expect(403);
    const generalEvidence = (await request(app).get(evidence.replace(`&repositoryId=${repo.id}`, '')).set(auth(owner.token)).expect(200)).body;
    expect(generalEvidence.every((event: any) => event.user_id === owner.user.id && event.repository_id !== foreign.id)).toBe(true);
    await request(app).get(evidence.replace(`userId=${owner.user.id}`, 'userId=invalid')).set(auth(owner.token)).expect(400);
  }, 30_000);
});
