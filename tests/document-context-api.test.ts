import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {decodeReportContext, decodeScheduleDays} from '../apps/server/src/document-context.js';
import {materializeDueReportSchedules} from '../apps/server/src/report-schedule.js';
import type {DB} from '../apps/server/src/db.js';

const auth = (token: string) => ({authorization: `Bearer ${token}`});
let db: DB;
afterEach(async () => { await db?.close(); db = undefined as unknown as DB; });

const documentContext = [{
  displayName: 'Plan.pdf', format: 'pdf', mediaType: 'application/pdf', byteSize: 1200, pageOrSlideCount: 2,
  consentedAt: '2026-09-02T10:00:00.000Z', metadata: {title: 'Plan', shortSummary: 'Release context.', keyPoints: [], decisions: [], actionItems: [], projects: [], people: [], relevantDates: [], warnings: []},
}];
for (const [format, mediaType] of [['md', 'text/markdown'], ['txt', 'text/plain'], ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']]) {
  documentContext.push({...documentContext[0], displayName: `Plan.${format}`, format, mediaType, pageOrSlideCount: format === 'pptx' ? 1 : 0});
}

describe('document context API without schema changes', () => {
  it('stores manual metadata in the existing custom_prompt field', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({name: 'Docs', email: 'docs@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(account.token)).expect(200)).body[0];
    const job = (await request(app).post('/api/reports/jobs').set(auth(account.token)).send({workspaceId: String(workspace.id), startDate: '2026-09-01', endDate: '2026-09-01', reporter: 'codex', documentContext}).expect(201)).body;
    const row: any = await db.prepare('SELECT custom_prompt FROM report_jobs WHERE id=?').get(job.id);
    expect(decodeReportContext(row.custom_prompt).documents).toEqual(documentContext);
    const migrations: any[] = await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(Math.max(...migrations.map(item => Number(item.version)))).toBe(23);
  });

  it('rejects document bytes, extracted text, and local paths at the hosted API boundary', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({name: 'Privacy', email: 'privacy@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(account.token)).expect(200)).body[0];
    for (const unsafe of [
      {...documentContext[0], documentBytes: 'JVBERi0='},
      {...documentContext[0], extractedText: 'raw private document text'},
      {...documentContext[0], displayName: '/home/privacy/Plan.pdf'},
    ]) await request(app).post('/api/reports/jobs').set(auth(account.token)).send({workspaceId: String(workspace.id), startDate: '2026-09-01', endDate: '2026-09-01', reporter: 'codex', documentContext: [unsafe]}).expect(422);
    expect(await db.prepare('SELECT COUNT(*) count FROM report_jobs').get()).toMatchObject({count: 0});
  });

  it('adds context after saving a weekday schedule, consumes it once, and preserves job snapshots', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const account = (await request(app).post('/api/auth/register').send({name: 'Schedule docs', email: 'schedule-docs@example.test', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(account.token)).expect(200)).body[0];
    const url = `/api/workspaces/${workspace.id}/report-schedule`;
    const rule = {name: 'Context schedule', enabled: true, frequency: 'WEEKDAYS', selectedDays: [], localTime: '09:00', timezone: 'UTC', reporter: 'codex', format: 'summary', includeDiff: false, notifySlack: false, windowDays: 1};
    await request(app).patch(`${url}/context`).set(auth(account.token)).send({add: documentContext}).expect(404);
    const schedule = (await request(app).put(url).set(auth(account.token)).send(rule).expect(200)).body;
    expect(schedule.document_context).toEqual([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const attached = (await request(app).patch(`${url}/context`).set(auth(account.token)).send({add: documentContext}).expect(200)).body;
      expect(attached).toMatchObject({next_run_at: schedule.next_run_at, configured_by: schedule.configured_by, frequency: 'WEEKDAYS', document_context: documentContext});
    }
    // A stale settings form does not clear attachments or reattach consumed ones.
    const renamed = (await request(app).put(url).set(auth(account.token)).send({...rule, name: 'Renamed schedule'}).expect(200)).body;
    expect(renamed.document_context).toEqual(documentContext);
    await db.prepare('UPDATE report_schedules SET next_run_at=? WHERE id=?').run('2026-09-04T09:00:00.000Z', schedule.id);
    expect(await materializeDueReportSchedules(db, account.user.id, new Date('2026-09-04T10:00:00.000Z'))).toBe(1);
    expect(await materializeDueReportSchedules(db, account.user.id, new Date('2026-09-04T10:00:00.000Z'))).toBe(0);
    const firstJob: any = await db.prepare('SELECT * FROM report_jobs WHERE schedule_id=?').get(schedule.id);
    expect(decodeReportContext(firstJob.custom_prompt).documents).toEqual(documentContext);
    const consumed = (await request(app).get(url).set(auth(account.token)).expect(200)).body;
    expect(consumed).toMatchObject({document_context: [], next_run_at: '2026-09-07T09:00:00.000Z'});
    await request(app).put(url).set(auth(account.token)).send(rule).expect(200);
    await db.prepare('UPDATE report_schedules SET next_run_at=? WHERE id=?').run('2026-09-07T09:00:00.000Z', schedule.id);
    await materializeDueReportSchedules(db, account.user.id, new Date('2026-09-07T10:00:00.000Z'));
    const jobs: any[] = await db.prepare('SELECT * FROM report_jobs WHERE schedule_id=? ORDER BY id').all(schedule.id);
    expect(jobs).toHaveLength(2);
    expect(decodeReportContext(jobs[1].custom_prompt).documents).toEqual([]);
    const nextDocument = {...documentContext[1], displayName: 'Monday work.md'};
    await request(app).patch(`${url}/context`).set(auth(account.token)).send({add: [nextDocument]}).expect(200);
    await materializeDueReportSchedules(db, account.user.id, new Date('2026-09-08T10:00:00.000Z'));
    const latest: any[] = await db.prepare('SELECT * FROM report_jobs WHERE schedule_id=? ORDER BY id').all(schedule.id);
    expect(latest).toHaveLength(3);
    expect(decodeReportContext(latest[0].custom_prompt).documents).toEqual(documentContext);
    expect(decodeReportContext(latest[1].custom_prompt).documents).toEqual([]);
    expect(decodeReportContext(latest[2].custom_prompt).documents).toEqual([nextDocument]);
  });

  it('protects scheduled attachments and preserves timing and generator ownership when another Manager adds context', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@example.test`, password: 'password123'}).expect(201)).body;
    const owner = await register('owner');
    const contributor = await register('contributor');
    const workspaceId = owner.workspaceId;
    const url = `/api/workspaces/${workspaceId}/report-schedule`;
    const rule = {enabled: false, frequency: 'SELECTED_DAYS', selectedDays: [1, 3], localTime: '09:00', timezone: 'UTC', reporter: 'codex', windowDays: 1, documentContext};
    const schedule = (await request(app).put(url).set(auth(owner.token)).send(rule).expect(200)).body;
    await request(app).patch(`${url}/context`).send({add: documentContext}).expect(401);
    await request(app).patch(`${url}/context`).set(auth(contributor.token)).send({add: documentContext}).expect(403);
    const invitation = (await request(app).post(`/api/workspaces/${workspaceId}/invitations`).set(auth(owner.token)).send({email: contributor.user.email, role: 'Developer'}).expect(201)).body;
    await request(app).post(`/api/invitations/${invitation.id}/accept`).set(auth(contributor.token)).expect(200);
    await request(app).patch(`${url}/context`).set(auth(contributor.token)).send({remove: [`${documentContext[0].displayName}\0${documentContext[0].consentedAt}`]}).expect(403);
    await request(app).patch(`/api/workspaces/${workspaceId}/members/${contributor.user.id}`).set(auth(owner.token)).send({role: 'Manager'}).expect(200);
    const extra = {...documentContext[1], displayName: 'Extra.md'};
    const attached = (await request(app).patch(`${url}/context`).set(auth(contributor.token)).send({add: [extra]}).expect(200)).body;
    expect(attached).toMatchObject({configured_by: owner.user.id, next_run_at: schedule.next_run_at, enabled: false, selected_days: [1, 3], document_context: [...documentContext, extra]});
    await request(app).patch(`${url}/context`).set(auth(owner.token)).send({add: [{...extra, displayName: 'Sixth.md'}]}).expect(422);
    await request(app).patch(`${url}/context`).set(auth(owner.token)).send({add: [{...extra, extractedText: 'private text'}]}).expect(422);
    await request(app).patch(`${url}/context`).set(auth(owner.token)).send({remove: [123]}).expect(422);
    expect(await materializeDueReportSchedules(db, owner.user.id, new Date('2026-09-09T10:00:00.000Z'))).toBe(0);
    const retained = (await request(app).get(url).set(auth(owner.token)).expect(200)).body;
    expect(retained.document_context).toEqual([...documentContext, extra]);
    const removed = (await request(app).patch(`${url}/context`).set(auth(contributor.token)).send({remove: [`${extra.displayName}\0${extra.consentedAt}`]}).expect(200)).body;
    expect(removed).toMatchObject({configured_by: owner.user.id, selected_days: [1, 3], document_context: documentContext});
    expect(decodeScheduleDays((await db.prepare('SELECT selected_days FROM report_schedules WHERE id=?').get(schedule.id) as any).selected_days).documents).toEqual(documentContext);
  });
});
