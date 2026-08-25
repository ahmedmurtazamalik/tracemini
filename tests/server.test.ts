import {afterEach, describe, expect, it, vi} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
import crypto from 'node:crypto';
import type {DB} from '../apps/server/src/db.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import {createApp} from '../apps/server/src/app.js';

let db: DB;
afterEach(async () => {
  vi.restoreAllMocks();
  if (db) {
    await db.close();
    db = undefined as unknown as DB;
  }
});
const auth = (token: string) => ({authorization: `Bearer ${token}`});
const installToken = (installation: any) => decodeURIComponent(installation.installCommand.match(/\/api\/installers\/linux\/([^']+)/)[1]);
const execFileAsync = promisify(execFile);

class SerializedTransactionsDb {
  private tail: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private pendingPushReads = 0;
  private releasePendingPushReads?: () => void;
  private readonly pendingPushReadsReady = new Promise<void>(resolve => { this.releasePendingPushReads = resolve; });

  constructor(private readonly inner: DB) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    if (sql !== "SELECT * FROM pending_pushes WHERE id=? AND agent_id=? AND status='pending'") return statement;
    return {
      ...statement,
      get: async (...values: any[]) => {
        const row = await statement.get(...values);
        if (!this.transactionContext.getStore()) {
          this.pendingPushReads += 1;
          if (this.pendingPushReads === 2) this.releasePendingPushReads?.();
          await this.pendingPushReadsReady;
        }
        return row;
      },
    };
  }

  query(text: string, values?: any[]) { return this.inner.query(text, values); }

  async transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.inner.transaction(async () => this.transactionContext.run(true, () => fn(this as unknown as DB)));
    } finally {
      release();
    }
  }
}

class TransactionRecordingDb {
  readonly calls: Array<{sql: string; inTransaction: boolean}> = [];
  private readonly transactionContext = new AsyncLocalStorage<boolean>();

  constructor(private readonly inner: DB) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    const record = (fn: (...values: any[]) => any) => async (...values: any[]) => {
      this.calls.push({sql, inTransaction: Boolean(this.transactionContext.getStore())});
      return fn(...values);
    };
    return {get: record(statement.get), all: record(statement.all), run: record(statement.run)};
  }

  query(text: string, values?: any[]) { return this.inner.query(text, values); }
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    return this.inner.transaction(async () => this.transactionContext.run(true, () => fn(this as unknown as DB)));
  }
  reset() { this.calls.length = 0; }
}

class ManagerPreflightGateDb {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private triggered = false;
  private signalReached!: () => void;
  private releaseGate!: () => void;
  readonly reached = new Promise<void>(resolve => { this.signalReached = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseGate = resolve; });

  constructor(private readonly inner: DB) {}

  prepare(sql: string) {
    const statement = this.inner.prepare(sql);
    if (sql !== 'SELECT * FROM workspace_members WHERE user_id=? AND workspace_id=?') return statement;
    return {
      ...statement,
      get: async (...values: any[]) => {
        const row = await statement.get(...values);
        if (!this.triggered && !this.transactionContext.getStore()) {
          this.triggered = true;
          this.signalReached();
          await this.released;
        }
        return row;
      },
    };
  }

  query(text: string, values?: any[]) { return this.inner.query(text, values); }
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    return this.inner.transaction(async () => this.transactionContext.run(true, () => fn(this as unknown as DB)));
  }
  release() { this.releaseGate(); }
}

describe('approved server workflows', () => {
  it('uses database-aware health and returns a retryable response when hosted sessions are exhausted', async () => {
    const failure: any = new Error('MaxClientsInSessionMode: max clients reached in session mode');
    failure.code = 'EMAXCONNSESSION';
    const unavailable = {query: async () => { throw failure; }} as unknown as DB;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(createApp(unavailable)).get('/api/health').expect(503);
    expect(response.body.error).toContain('temporarily busy');
    expect(response.headers['retry-after']).toBe('5');
    logged.mockRestore();
  });

  it('describes the installed background service as a device', () => {
    const installerSource = fs.readFileSync(path.resolve('packages/cli/src/install.ts'), 'utf8');
    expect(installerSource).toContain('Description=TraceMini local Git device');
    expect(installerSource).not.toContain('Description=TraceMini local Git agent');
  });

  it('creates a personal Manager workspace with a random invite when a user registers', async () => {
    db = await openTestDb();
    const app = createApp(db);
    expect((await request(app).get('/api/agents/status').set(auth('invalid-device-token')).expect(401)).body).toEqual({error: 'unauthorized device'});
    await request(app).post('/api/auth/password-reset/request').send({email: 'joey@test.local'}).expect(404);
    await request(app).post('/api/auth/password-reset/complete').send({token: 'removed', password: 'password123'}).expect(404);

    const joey = (await request(app).post('/api/auth/register').send({name: 'Joey', email: 'joey@test.local', password: 'password123'}).expect(201)).body;
    const workspaces = (await request(app).get('/api/workspaces').set(auth(joey.token)).expect(200)).body;

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({name: "Joey's workspace", role: 'Manager', invite_enabled: true});
    expect(workspaces[0].invite_code).toMatch(/^[A-F0-9]{10}$/);

    const jane = (await request(app).post('/api/auth/register').send({name: 'Jane', email: 'jane@test.local', password: 'password123'}).expect(201)).body;
    const janeWorkspace = (await request(app).get('/api/workspaces').set(auth(jane.token)).expect(200)).body[0];
    expect(janeWorkspace.invite_code).not.toBe(workspaces[0].invite_code);
  });

  it('retries invite-code collisions without misreporting them as duplicate email', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const holder = (await request(app).post('/api/auth/register').send({name: 'Holder', email: 'holder@test.local', password: 'password123'}).expect(201)).body;
    const holderWorkspace = (await request(app).get('/api/workspaces').set(auth(holder.token)).expect(200)).body[0];
    await db.prepare('UPDATE workspaces SET invite_code=? WHERE id=?').run('AAAAAAAAAA', holderWorkspace.id);

    const realRandomBytes = crypto.randomBytes.bind(crypto);
    const inviteBytes = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'];
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) =>
      size === 5 ? Buffer.from(inviteBytes.shift()!, 'hex') : realRandomBytes(size)) as any);

    const newcomer = (await request(app).post('/api/auth/register').send({name: 'Collision', email: 'collision@test.local', password: 'password123'}).expect(201)).body;
    const newcomerWorkspace = (await request(app).get('/api/workspaces').set(auth(newcomer.token)).expect(200)).body[0];
    expect(newcomerWorkspace.invite_code).toBe('BBBBBBBBBB');

    const refreshed = await request(app).post(`/api/workspaces/${newcomerWorkspace.id}/invite/regenerate`).set(auth(newcomer.token)).expect(200);
    expect(refreshed.body.inviteCode).toBe('CCCCCCCCCC');
  });

  it('serializes invite refreshes and permits only one new code per minute', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Invite', email: 'invite@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).get('/api/workspaces').set(auth(user.token)).expect(200)).body[0];

    const responses = await Promise.all([
      request(app).post(`/api/workspaces/${workspace.id}/invite/regenerate`).set(auth(user.token)),
      request(app).post(`/api/workspaces/${workspace.id}/invite/regenerate`).set(auth(user.token)),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
    const refreshed = responses.find(response => response.status === 200)!.body.inviteCode;
    expect(refreshed).toMatch(/^[A-F0-9]{10}$/);
    expect(refreshed).not.toBe(workspace.invite_code);
    const limited = responses.find(response => response.status === 429)!;
    expect(limited.body).toMatchObject({error: expect.stringContaining('once per minute'), retryAfter: expect.any(Number)});
    expect(limited.headers['retry-after']).toBe(String(limited.body.retryAfter));
    expect((await db.prepare('SELECT invite_code FROM workspaces WHERE id=?').get(workspace.id) as any).invite_code).toBe(refreshed);

    await db.prepare('UPDATE workspaces SET invite_refreshed_at=? WHERE id=?').run(new Date(Date.now() - 61_000).toISOString(), workspace.id);
    const afterBoundary = await request(app).post(`/api/workspaces/${workspace.id}/invite/regenerate`).set(auth(user.token)).expect(200);
    expect(afterBoundary.body.inviteCode).not.toBe(refreshed);
  });

  it('rejects invalid registration email and password values at the API boundary', async () => {
    db = await openTestDb();
    const app = createApp(db);
    await request(app).post('/api/auth/register').send({name: 'Short', email: 'short@example.test', password: 'short'}).expect(400);
    await request(app).post('/api/auth/register').send({name: 'Invalid', email: 'not-an-email', password: 'password123'}).expect(400);
    await request(app).post('/api/auth/register').send({name: '   ', email: 'blank@example.test', password: 'password123'}).expect(400);
    await request(app).post('/api/auth/register').send({name: 'Duplicate', email: 'duplicate@example.test', password: 'password123'}).expect(201);
    await request(app).post('/api/auth/register').send({name: 'Duplicate again', email: 'duplicate@example.test', password: 'password123'}).expect(409);
  });

  it('exchanges an install token once and enforces Manager invariants', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@test.local`, password: 'password123'}).expect(201)).body;
    const manager = await register('manager');
    const memberUser = await register('member');
    const workspace = (await request(app).post('/api/workspaces').set(auth(manager.token)).send({name: 'Managed'}).expect(201)).body;
    expect((await request(app).get('/api/workspaces').set(auth(manager.token))).body[0].role).toBe('Manager');
    await request(app).post('/api/workspaces/join').set(auth(memberUser.token)).send({inviteCode: workspace.inviteCode}).expect(200);
    const visibleMembers = (await request(app).get(`/api/workspaces/${workspace.id}/members`).set(auth(memberUser.token)).expect(200)).body;
    expect(visibleMembers.map((member: any) => member.name)).toEqual(expect.arrayContaining(['manager', 'member']));
    await request(app).get(`/api/workspaces/${workspace.id}/repositories`).set(auth(memberUser.token)).expect(200);

    const installation = (await request(app).post('/api/agents/installations').set(auth(memberUser.token)).send({workspaceId: workspace.id}).expect(201)).body;
    expect(installation).not.toHaveProperty('code');
    const token = installToken(installation);
    const exchange = (await request(app).post('/api/agents/install/exchange').send({installToken: token, machineName: 'member-box'}).expect(201)).body;
    expect(exchange).toMatchObject({workspaceId: workspace.id, agentId: expect.any(Number), agentToken: expect.any(String)});
    expect(exchange).not.toHaveProperty('userToken');
    await request(app).post('/api/agents/install/exchange').send({installToken: token, machineName: 'replay'}).expect(409);

    const memberId = memberUser.user.id;
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(memberUser.token)).send({role: 'Manager'}).expect(403);
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(manager.token)).send({role: 'Manager'}).expect(200);
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${manager.user.id}`).set(auth(manager.token)).send({role: 'Member'}).expect(200);
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(memberUser.token)).send({role: 'Member'}).expect(409);
    await request(app).delete(`/api/workspaces/${workspace.id}/members/${memberId}`).set(auth(memberUser.token)).expect(409);
    await request(app).post(`/api/workspaces/${workspace.id}/invite/regenerate`).set(auth(manager.token)).expect(403);
  });

  it('serves and runs the Linux CLI bundle in an isolated home', async () => {
    db = await openTestDb();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-installer-'));
    const home = path.join(temporary, "home with ' quote");
    const cliDir = path.join(temporary, 'compiled-cli');
    const fakeBin = path.join(temporary, 'bin');
    fs.mkdirSync(home, {recursive: true});
    fs.mkdirSync(cliDir);
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(cliDir, 'index.js'), `#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2), command=args.shift(), flag=n=>args[args.indexOf(n)+1]; const configPath=path.join(os.homedir(),'.tracemini','config.json');
if(command==='install'){const response=await fetch(flag('--server')+'/api/agents/install/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({installToken:flag('--install-token'),machineName:'fixture-box'})});if(!response.ok)throw new Error(await response.text());const value=await response.json();fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,JSON.stringify({serverUrl:flag('--server'),agentToken:value.agentToken,workspaceId:value.workspaceId}));fs.mkdirSync(path.join(os.homedir(),'.config/systemd/user'),{recursive:true});fs.writeFileSync(path.join(os.homedir(),'.config/systemd/user/tracemini.service'),'fixture');execFileSync('systemctl',['--user','daemon-reload']);execFileSync('systemctl',['--user','enable','--now','tracemini.service']);console.log('installed');}
else if(command==='status'){console.log(JSON.stringify(JSON.parse(fs.readFileSync(configPath,'utf8'))));}
`);
    fs.writeFileSync(path.join(fakeBin, 'node'), `#!/bin/sh\nif [ "\${1:-}" = -p ]; then echo 22; else exec ${process.execPath} "$@"; fi\n`, {mode: 0o755});
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/systemctl.log"\n`, {mode: 0o755});
    const app = createApp(db, undefined, cliDir);
    const server = app.listen(0);
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
      const origin = `http://127.0.0.1:${address.port}`;
      const user = (await request(origin).post('/api/auth/register').send({name: 'Installer', email: 'installer@test.local', password: 'password123'}).expect(201)).body;
      const workspace = (await request(origin).post('/api/workspaces').set(auth(user.token)).send({name: 'Install'}).expect(201)).body;
      const installation = (await request(origin).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
      expect(installation.installCommand).toContain('curl --fail');
      expect(installation.installCommand).not.toContain('| sh');
      const token = installToken(installation);
      const bundle = await request(origin).get(`/api/installers/linux/${encodeURIComponent(token)}`).expect(200).expect('content-type', /text\/x-shellscript/);
      const installerPath = path.join(temporary, 'install.sh');
      fs.writeFileSync(installerPath, bundle.text, {mode: 0o700});
      const env = {...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`};
      await execFileAsync('sh', [installerPath], {env});
      const wrapper = path.join(home, '.local/bin/tracemini');
      expect(fs.existsSync(wrapper)).toBe(true);
      expect(execFileSync(wrapper, ['status'], {env, encoding: 'utf8'})).toContain(origin);
      expect(fs.readFileSync(path.join(home, 'systemctl.log'), 'utf8')).toContain('--user enable --now tracemini.service');
      await request(origin).post('/api/agents/install/exchange').send({installToken: token, machineName: 'replay'}).expect(409);
      await request(origin).get(`/api/installers/linux/${encodeURIComponent(token)}`).expect(410);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });

  it('queues refresh and push work, exposes stats, archive and agent status', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Ada', email: 'ada@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Mini'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'ada-box'}).expect(201)).body;
    const detectedDevices = (await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(user.token)).expect(200)).body;
    expect(detectedDevices).toContainEqual(expect.objectContaining({id: agent.agentId, user_id: user.user.id, machine_name: 'ada-box'}));
    const repo = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Project', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone', branch: 'main', headSha: 'abc', remoteHeadSha: 'abc'}).expect(200)).body;
    const renamedRepo = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'RemoteProject', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone', branch: 'main', headSha: 'abc', remoteHeadSha: 'abc'}).expect(200)).body;
    expect(renamedRepo).toMatchObject({id: repo.id, name: 'RemoteProject'});

    const refresh = (await request(app).post(`/api/workspaces/${workspace.id}/refresh`).set(auth(user.token)).expect(201)).body;
    expect((await request(app).get('/api/agents/refresh-requests').set(auth(agent.agentToken)).expect(200)).body[0].id).toBe(refresh.id);
    await request(app).post(`/api/agents/refresh-requests/${refresh.id}/claim`).set(auth(agent.agentToken)).expect(200);
    await request(app).post(`/api/agents/refresh-requests/${refresh.id}/complete`).set(auth(agent.agentToken)).send({repositoriesFound: 2}).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/refresh`).set(auth(user.token)).expect(200)).body[0]).toMatchObject({status: 'completed', repositories_found: 2});

    const pending = (await request(app).post('/api/pushes/pending').set(auth(agent.agentToken)).send({repositoryId: repo.id, eventKey: 'push-1', remoteName: 'origin', remoteUrl: 'file:///tmp/remote.git', ref: 'refs/heads/main', expectedSha: 'abc', occurredAt: new Date().toISOString()}).expect(201)).body;
    expect((await request(app).get('/api/agents/pushes').set(auth(agent.agentToken)).expect(200)).body[0].id).toBe(pending.id);
    expect((await request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'unconfirmed'}).expect(200)).body.retrying).toBe(true);
    expect((await request(app).get('/api/agents/pushes').set(auth(agent.agentToken)).expect(200)).body).toEqual([]);
    await db.prepare("UPDATE pending_pushes SET attempts=2,next_check_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(pending.id);
    await request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'confirmed', observedSha: 'abc'}).expect(200);

    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'commit-stat', repositoryId: repo.id, type: 'commit', occurredAt: '2026-08-21T10:00:00.000Z', data: {filesChanged: 3, insertions: 12, deletions: 4}}).expect(201);
    await request(app).post('/api/activity').set(auth(agent.agentToken)).send({eventKey: 'stage-stat', repositoryId: repo.id, type: 'stage', occurredAt: '2026-08-21T11:00:00.000Z', data: {filesChanged: 99, insertions: 99, deletions: 99}}).expect(201);
    const stats = (await request(app).get(`/api/workspaces/${workspace.id}/stats`).set(auth(user.token)).expect(200)).body;
    expect(stats.totals).toEqual({commits: 1, filesChanged: 3, insertions: 12, deletions: 4});
    expect(stats.daily[0]).toMatchObject({date: '2026-08-21', commits: 1});

    await request(app).patch(`/api/workspaces/${workspace.id}/repositories/${repo.id}`).set(auth(user.token)).send({archived: true}).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/repositories?includeArchived=true`).set(auth(user.token))).body[0].archived).toBe(1);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/agents`).set(auth(user.token)).expect(200)).body[0]).toMatchObject({machine_name: 'ada-box', status: 'online'});
    await request(app).post(`/api/workspaces/${workspace.id}/agents/${agent.agentId}/revoke`).set(auth(user.token)).expect(200);
    await request(app).post('/api/agents/heartbeat').set(auth(agent.agentToken)).expect(401);
    await request(app).delete(`/api/workspaces/${workspace.id}`).set(auth(user.token)).expect(204);
    expect((await request(app).get('/api/workspaces').set(auth(user.token)).expect(200)).body).toMatchObject([{name: "Ada's workspace", role: 'Manager'}]);
  });

  it('allows only one concurrent push finalizer to publish the winning outcome', async () => {
    db = await openTestDb();
    const app = createApp(new SerializedTransactionsDb(db) as unknown as DB);
    const user = (await request(app).post('/api/auth/register').send({name: 'Push', email: 'push-race@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Push Race'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'push-box'}).expect(201)).body;
    const repository = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Race', remoteUrl: 'file:///tmp/race.git', localKey: '/race'}).expect(200)).body;
    const pending = (await request(app).post('/api/pushes/pending').set(auth(agent.agentToken)).send({repositoryId: repository.id, eventKey: 'push-race', remoteName: 'origin', remoteUrl: 'file:///tmp/race.git', ref: 'refs/heads/main', expectedSha: 'expected', occurredAt: '2026-08-24T00:00:00.000Z'}).expect(201)).body;
    await db.prepare('UPDATE pending_pushes SET attempts=2 WHERE id=?').run(pending.id);

    const responses = await Promise.all([
      request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'confirmed', observedSha: 'confirmed-sha'}),
      request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'unconfirmed', observedSha: 'unconfirmed-sha'}),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const push: any = await db.prepare('SELECT * FROM pending_pushes WHERE id=?').get(pending.id);
    const event: any = await db.prepare('SELECT * FROM activity_events WHERE event_key=?').get('push-race');
    const eventData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    expect(eventData).toMatchObject({confirmation: push.status, observedSha: push.observed_sha});
  });

  it('rejects a privileged member mutation when manager authority becomes stale', async () => {
    db = await openTestDb();
    const setupApp = createApp(db);
    const register = async (name: string) => (await request(setupApp).post('/api/auth/register').send({name, email: `${name}@manager-race.test`, password: 'password123'}).expect(201)).body;
    const actor = await register('stale-manager');
    const backup = await register('backup-manager');
    const target = await register('promotion-target');
    const workspace = (await request(setupApp).post('/api/workspaces').set(auth(actor.token)).send({name: 'Authority Race'}).expect(201)).body;
    for (const user of [backup, target]) await request(setupApp).post('/api/workspaces/join').set(auth(user.token)).send({inviteCode: workspace.inviteCode}).expect(200);
    await request(setupApp).patch(`/api/workspaces/${workspace.id}/members/${backup.user.id}`).set(auth(actor.token)).send({role: 'Manager'}).expect(200);

    const gated = new ManagerPreflightGateDb(db);
    const app = createApp(gated as unknown as DB);
    const responsePromise = request(app).patch(`/api/workspaces/${workspace.id}/members/${target.user.id}`).set(auth(actor.token)).send({role: 'Manager'}).then(response => response);
    await gated.reached;
    await db.prepare("UPDATE workspace_members SET role='Member' WHERE workspace_id=? AND user_id=?").run(workspace.id, actor.user.id);
    gated.release();

    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect((await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id, target.user.id) as any).role).toBe('Member');
  });

  it('keeps lifecycle authority and target selection inside workspace transactions', async () => {
    db = await openTestDb();
    const recording = new TransactionRecordingDb(db);
    const app = createApp(recording as unknown as DB);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@locks.test`, password: 'password123'}).expect(201)).body;
    const manager = await register('locking-manager');
    const member = await register('locking-member');
    const workspace = (await request(app).post('/api/workspaces').set(auth(manager.token)).send({name: 'Locked'}).expect(201)).body;
    await request(app).post('/api/workspaces/join').set(auth(member.token)).send({inviteCode: workspace.inviteCode}).expect(200);
    const installation = (await request(app).post('/api/agents/installations').set(auth(member.token)).send({workspaceId: workspace.id}).expect(201)).body;

    recording.reset();
    const exchanged = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'locked-box'}).expect(201)).body;
    const exchangeSql = recording.calls.filter(call => call.inTransaction).map(call => call.sql);
    expect(exchangeSql.findIndex(sql => sql === 'SELECT id FROM workspaces WHERE id=? FOR UPDATE')).toBeLessThan(exchangeSql.findIndex(sql => sql.includes('FROM setup_codes') && sql.includes('FOR UPDATE')));
    expect(exchangeSql).toContain('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?');

    recording.reset();
    await request(app).patch(`/api/workspaces/${workspace.id}/members/${member.user.id}`).set(auth(manager.token)).send({role: 'Manager'}).expect(200);
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});

    recording.reset();
    await request(app).post(`/api/workspaces/${workspace.id}/refresh`).set(auth(manager.token)).expect(201);
    expect(recording.calls.some(call => call.inTransaction && call.sql.includes('FROM agents a') && call.sql.includes('a.revoked_at IS NULL') && call.sql.includes('workspace_members'))).toBe(true);

    recording.reset();
    await request(app).post(`/api/workspaces/${workspace.id}/agents/${exchanged.agentId}/revoke`).set(auth(manager.token)).expect(200);
    const revokeSql = recording.calls.filter(call => call.inTransaction).map(call => call.sql);
    expect(revokeSql.findIndex(sql => sql.includes('FROM agents') && sql.includes('FOR UPDATE'))).toBeLessThan(revokeSql.findIndex(sql => sql.startsWith('UPDATE refresh_requests')));
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});

    recording.reset();
    await request(app).delete(`/api/workspaces/${workspace.id}/members/${member.user.id}`).set(auth(manager.token)).expect(204);
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});

    recording.reset();
    await request(app).delete(`/api/workspaces/${workspace.id}`).set(auth(manager.token)).expect(204);
    expect(recording.calls).toContainEqual({sql: "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'", inTransaction: true});
  });

  it('binds agents and report work to one workspace and revokes them on member removal', async () => {
    db = await openTestDb();
    const app = createApp(db);
    const createUser = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@isolation.test`, password: 'password123'}).expect(201)).body;
    const member = await createUser('bound-member');
    const manager = await createUser('removing-manager');
    const workspaceA = (await request(app).post('/api/workspaces').set(auth(member.token)).send({name: 'Workspace A'}).expect(201)).body;
    const workspaceB = (await request(app).post('/api/workspaces').set(auth(member.token)).send({name: 'Workspace B'}).expect(201)).body;
    await request(app).post('/api/workspaces/join').set(auth(manager.token)).send({inviteCode: workspaceA.inviteCode}).expect(200);
    await request(app).patch(`/api/workspaces/${workspaceA.id}/members/${manager.user.id}`).set(auth(member.token)).send({role: 'Manager'}).expect(200);

    const installation = (await request(app).post('/api/agents/installations').set(auth(member.token)).send({workspaceId: workspaceA.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'workspace-a-box'}).expect(201)).body;
    expect((await request(app).get(`/api/workspaces/${workspaceA.id}/agents`).set(auth(member.token)).expect(200)).body).toHaveLength(1);
    expect((await request(app).get(`/api/workspaces/${workspaceB.id}/agents`).set(auth(member.token)).expect(200)).body).toEqual([]);
    await request(app).post(`/api/workspaces/${workspaceB.id}/agents/${agent.agentId}/revoke`).set(auth(member.token)).expect(404);

    const jobResponse = await request(app).post('/api/reports/jobs').set(auth(member.token)).send({workspaceId: String(workspaceA.id), startDate: '2026-08-21', endDate: '2026-08-21', reporter: 'codex'});
    expect(jobResponse.status, JSON.stringify(jobResponse.body)).toBe(201);
    const job = jobResponse.body;
    await request(app).delete(`/api/workspaces/${workspaceA.id}/members/${member.user.id}`).set(auth(manager.token)).expect(204);
    await request(app).post('/api/agents/heartbeat').set(auth(agent.agentToken)).expect(401);
    await request(app).post(`/api/agents/jobs/${job.id}/claim`).set(auth(agent.agentToken)).expect(401);
    expect((await request(app).get(`/api/reports/jobs/${job.id}`).set(auth(member.token)).expect(200)).body).toMatchObject({status: 'failed', error: 'workspace membership removed'});
  });
});
