import {afterEach, describe, expect, it, vi} from 'vitest';
import request from 'supertest';
import {createApp} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import type {DB} from '../apps/server/src/db.js';

let db: DB;
const auth = (token: string) => ({authorization: `Bearer ${token}`});
afterEach(async () => { await db?.close(); vi.unstubAllEnvs(); });

async function setup() {
  db = await openTestDb();
  const notifier = vi.fn().mockResolvedValue(undefined);
  const app = createApp(db, undefined, undefined, notifier);
  const people = [];
  const devices = [];
  for (const name of ['manager', 'first-member', 'second-member']) {
    const person = (await request(app).post('/api/auth/register').send({name, email: `${name}@example.test`, password: 'password123'}).expect(201)).body;
    if (people.length) {
      const invite = (await request(app).post(`/api/workspaces/${people[0].workspaceId}/invitations`).set(auth(people[0].token)).send({email: person.user.email, role: 'Developer'}).expect(201)).body;
      await request(app).post(`/api/invitations/${invite.id}/accept`).set(auth(person.token)).expect(200);
    }
    people.push(person);
    devices.push((await request(app).post('/api/agents/register').set(auth(person.token)).send({machineName: name}).expect(201)).body);
  }
  return {app, notifier, people, devices, workspaceId: people[0].workspaceId};
}

async function dueSchedule(app: any, manager: any) {
  const url = `/api/workspaces/${manager.workspaceId}/report-schedule`;
  const rule = {enabled: true, frequency: 'DAILY', localTime: '00:00', timezone: 'UTC', reporter: 'hermes', windowDays: 1};
  const schedule = (await request(app).put(url).set(auth(manager.token)).send(rule).expect(200)).body;
  await db.prepare('UPDATE report_schedules SET next_run_at=? WHERE id=?').run(new Date(Date.now() - 86_400_000).toISOString(), schedule.id);
  return rule;
}

const sync = async (app: any, device: any) => (await request(app).get('/api/agents/sync').set(auth(device.token)).expect(200)).body.jobs;
const claim = (app: any, device: any, id: number) => request(app).post(`/api/agents/jobs/${id}/claim`).set(auth(device.token));
const fail = (app: any, device: any, id: number) => request(app).post(`/api/agents/jobs/${id}/fail`).set(auth(device.token)).send({error: 'Local CLI unavailable'});
const complete = (app: any, device: any, id: number) => request(app).post(`/api/agents/jobs/${id}/complete`).set(auth(device.token)).send({markdown: '# Saved report'});

describe('scheduled report device fallback', () => {
  it('prefers the Manager, tries members one-by-one, redacts the executing member context, and saves one report', async () => {
    const {app, people: [manager, first, second], devices: [primary, backup, last], workspaceId} = await setup();
    const rule = await dueSchedule(app, manager);
    await request(app).put(`/api/workspaces/${workspaceId}/report-schedule`).set(auth(first.token)).send(rule).expect(403);
    // A member's poll materializes the shared job, even before the Manager polls.
    expect(await sync(app, backup)).toEqual([]);
    const [job] = await sync(app, primary);
    await claim(app, backup, job.id).expect(409);
    await claim(app, primary, job.id).expect(200);
    await claim(app, last, job.id).expect(409);
    await fail(app, primary, job.id).expect(200);
    expect(await sync(app, primary)).toEqual([]);
    expect((await sync(app, backup))[0].id).toBe(job.id);
    await claim(app, backup, job.id).expect(200);
    await fail(app, backup, job.id).expect(200);
    expect(await sync(app, backup)).toEqual([]);
    expect((await sync(app, last))[0].id).toBe(job.id);
    await claim(app, last, job.id).expect(200);

    const repo: any = await db.prepare('INSERT INTO repositories(workspace_id,name,remote_url,normalized_remote,created_at) VALUES(?,?,?,?,?) RETURNING id').get(workspaceId, 'private', 'file:///home/manager/private', 'file:///home/manager/private', new Date().toISOString());
    const event: any = await db.prepare('INSERT INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id')
      .get('private-event', manager.user.id, primary.agentId, repo.id, 'commit', new Date(`${job.end_date.slice(0, 10)}T12:00:00Z`).toISOString(), JSON.stringify({message: 'Updated /home/manager/private', sourceCode: 'DO_NOT_SHARE', localKey: '/home/manager/private'}), new Date().toISOString());
    await db.prepare('INSERT INTO activity_event_repositories(event_id,repository_id) VALUES(?,?)').run(event.id, repo.id);
    const context = (await request(app).get(`/api/agents/jobs/${job.id}/context`).set(auth(last.token)).expect(200)).body;
    expect(context).toMatchObject({agentUserId: second.user.id, job: {user_id: manager.user.id}, events: [{user_id: manager.user.id, local_key: null, normalized_remote: null}]});
    expect(JSON.stringify(context.events)).not.toMatch(/DO_NOT_SHARE|\/home\/manager/);
    await complete(app, primary, job.id).expect(409);
    await fail(app, backup, job.id).expect(409);
    await complete(app, last, job.id).expect(201);
    await complete(app, last, job.id).expect(409);
    const reports = (await request(app).get(`/api/workspaces/${workspaceId}/reports`).set(auth(first.token)).expect(200)).body;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({user_id: manager.user.id, report_scope: 'workspace', job_id: job.id});
    // Personal and manually requested workspace reports do not grant fallback access.
    for (const reportScope of ['personal', 'workspace']) {
      const manual = (await request(app).post('/api/reports/jobs').set(auth(manager.token)).send({workspaceId: String(workspaceId), startDate: '2026-10-01', endDate: '2026-10-01', reporter: 'hermes', reportScope}).expect(201)).body;
      await claim(app, last, manual.id).expect(409);
      await claim(app, primary, manual.id).expect(200);
      await fail(app, primary, manual.id).expect(200);
    }
  });

  it('recovers offline and timed-out attempts, rejects stale results, and stops after every device fails', async () => {
    const {app, people: [manager], devices: [primary, backup, last]} = await setup();
    await dueSchedule(app, manager);
    const offline = new Date(Date.now() - 3 * 60_000).toISOString();
    await db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(offline, primary.agentId);
    const [job] = await sync(app, backup);
    await claim(app, backup, job.id).expect(200);
    // A hung generator can keep heartbeating; the attempt still has a deadline.
    await db.prepare('UPDATE report_jobs SET claimed_at=? WHERE id=?').run(new Date(Date.now() - 6 * 60_000).toISOString(), job.id);
    expect((await sync(app, last))[0].id).toBe(job.id);
    await claim(app, last, job.id).expect(200);
    await complete(app, backup, job.id).expect(409);
    // Loss of heartbeats also moves the attempt on before the hard deadline.
    await db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(offline, last.agentId);
    expect((await sync(app, primary))[0].id).toBe(job.id);
    await claim(app, primary, job.id).expect(200);
    await request(app).get(`/api/agents/jobs/${job.id}/context`).set(auth(last.token)).expect(404);
    await fail(app, primary, job.id).expect(200);
    expect(await sync(app, backup)).toEqual([]);
    expect(await db.prepare('SELECT status,attempted_agent_ids FROM report_jobs WHERE id=?').get(job.id)).toMatchObject({status: 'failed', attempted_agent_ids: [backup.agentId, last.agentId, primary.agentId]});
  });

  it('excludes outsiders and revoked devices and moves a removed member’s running attempt to the next device', async () => {
    const {app, people: [manager, first, second], devices: [primary, backup, last], workspaceId} = await setup();
    await dueSchedule(app, manager);
    const [job] = await sync(app, primary);
    await claim(app, primary, job.id).expect(200);
    await request(app).post(`/api/workspaces/${workspaceId}/agents/${primary.agentId}/revoke`).set(auth(manager.token)).expect(200);
    await complete(app, primary, job.id).expect(401);
    expect((await sync(app, backup))[0].id).toBe(job.id);
    await claim(app, backup, job.id).expect(200);
    await request(app).delete(`/api/workspaces/${workspaceId}/members/${first.user.id}`).set(auth(manager.token)).expect(204);
    await complete(app, backup, job.id).expect(409);
    expect(await sync(app, backup)).toEqual([]);
    await claim(app, backup, job.id).expect(409);
    expect((await sync(app, last))[0].id).toBe(job.id);
    await claim(app, last, job.id).expect(200);
    await request(app).get(`/api/agents/jobs/${job.id}/context`).set(auth(backup.token)).expect(404);
    await complete(app, last, job.id).expect(201);
    expect((await request(app).get(`/api/workspaces/${workspaceId}/reports`).set(auth(second.token)).expect(200)).body).toHaveLength(1);
  });
});

describe('saved report Slack redelivery', () => {
  it('keeps failed reports, authorizes retry, prevents concurrent/repeated sends, and recovers unknown or interrupted delivery', async () => {
    const {app, notifier, people: [manager, first, second], devices: [, backup], workspaceId} = await setup();
    vi.stubEnv('SLACK_REPORT_WEBHOOK_URL', 'https://hooks.slack.test/SECRET');
    notifier.mockRejectedValueOnce(new Error('Failed https://hooks.slack.test/SECRET'));
    const job = (await request(app).post('/api/reports/jobs').set(auth(first.token)).send({workspaceId: String(workspaceId), startDate: '2026-10-01', endDate: '2026-10-01', reporter: 'hermes', notifySlack: true}).expect(201)).body;
    await claim(app, backup, job.id).expect(200);
    await complete(app, backup, job.id).expect(201);
    const [report] = (await request(app).get(`/api/workspaces/${workspaceId}/reports`).set(auth(first.token)).expect(200)).body;
    expect(report.slack_status).toBe('failed');
    const detail = (await request(app).get(`/api/reports/${report.id}`).set(auth(manager.token)).expect(200)).body;
    expect(detail.markdown).toBe('# Saved report');
    expect(JSON.stringify(detail)).not.toContain('SECRET');
    const retryUrl = `/api/reports/${report.id}/retry-slack`;
    await request(app).post(retryUrl).expect(401);
    await request(app).post(retryUrl).set(auth(second.token)).expect(404);
    notifier.mockRejectedValueOnce(new Error('Still unavailable'));
    expect((await request(app).post(retryUrl).set(auth(first.token)).expect(200)).body.slack_status).toBe('failed');
    let finish!: () => void;
    let started!: () => void;
    const delivering = new Promise<void>(resolve => { started = resolve; });
    notifier.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; started(); }));
    const firstRetry = request(app).post(retryUrl).set(auth(manager.token)).then(response => response);
    await delivering;
    await request(app).post(retryUrl).set(auth(first.token)).expect(409);
    finish();
    expect((await firstRetry).body.slack_status).toBe('sent');
    await request(app).post(retryUrl).set(auth(manager.token)).expect(409);
    expect(notifier).toHaveBeenCalledTimes(3);
    // Historical attempts have no known outcome. An interrupted send has a lease.
    await db.prepare("UPDATE reports SET slack_status='unknown' WHERE id=?").run(report.id);
    expect((await request(app).post(retryUrl).set(auth(manager.token)).expect(200)).body.slack_status).toBe('sent');
    await db.prepare("UPDATE reports SET slack_status='sending',slack_attempted_at=? WHERE id=?").run(new Date(Date.now() - 61_000).toISOString(), report.id);
    expect((await request(app).post(retryUrl).set(auth(manager.token)).expect(200)).body.slack_status).toBe('sent');
    const regeneration = (await request(app).post(`/api/reports/${report.id}/regenerate`).set(auth(first.token)).send({reporter: 'hermes', prompt: 'Use a brief summary.'}).expect(201)).body;
    await claim(app, backup, regeneration.id).expect(200);
    await complete(app, backup, regeneration.id).expect(201);
    expect(await db.prepare('SELECT slack_status,slack_attempted_at FROM reports WHERE id=?').get(report.id)).toMatchObject({slack_status: 'pending', slack_attempted_at: null});
    expect(notifier).toHaveBeenCalledTimes(5);
    await db.prepare('UPDATE reports SET slack_status=NULL WHERE id=?').run(report.id);
    await request(app).post(retryUrl).set(auth(manager.token)).expect(409);
  });
});
