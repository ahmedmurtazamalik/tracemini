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

const claim = (app: any, device: any, id: number) => request(app).post(`/api/agents/jobs/${id}/claim`).set(auth(device.token));
const complete = (app: any, device: any, id: number) => request(app).post(`/api/agents/jobs/${id}/complete`).set(auth(device.token)).send({markdown: '# Saved report'});

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
