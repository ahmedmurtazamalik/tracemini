import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {openDb, type DB} from '../apps/server/src/db.js';
import {createApp} from '../apps/server/src/app.js';

let db: DB;
afterEach(() => db?.close());
const auth = (token: string) => ({authorization: `Bearer ${token}`});
const installToken = (installation: any) => decodeURIComponent(installation.installCommand.match(/\/api\/installers\/linux\/([^']+)/)[1]);
const execFileAsync = promisify(execFile);

describe('approved server workflows', () => {
  it('exchanges an install token once and enforces Manager invariants', async () => {
    db = openDb(':memory:');
    const app = createApp(db);
    const register = async (name: string) => (await request(app).post('/api/auth/register').send({name, email: `${name}@test.local`, password: 'password123'}).expect(201)).body;
    const manager = await register('manager');
    const memberUser = await register('member');
    const workspace = (await request(app).post('/api/workspaces').set(auth(manager.token)).send({name: 'Managed'}).expect(201)).body;
    expect((await request(app).get('/api/workspaces').set(auth(manager.token))).body[0].role).toBe('Manager');
    await request(app).post('/api/workspaces/join').set(auth(memberUser.token)).send({inviteCode: workspace.inviteCode}).expect(200);

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
    db = openDb(':memory:');
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
    db = openDb(':memory:');
    const app = createApp(db);
    const user = (await request(app).post('/api/auth/register').send({name: 'Ada', email: 'ada@test.local', password: 'password123'}).expect(201)).body;
    const workspace = (await request(app).post('/api/workspaces').set(auth(user.token)).send({name: 'Mini'}).expect(201)).body;
    const installation = (await request(app).post('/api/agents/installations').set(auth(user.token)).send({workspaceId: workspace.id}).expect(201)).body;
    const agent = (await request(app).post('/api/agents/install/exchange').send({installToken: installToken(installation), machineName: 'ada-box'}).expect(201)).body;
    const repo = (await request(app).post('/api/repositories/register').set(auth(agent.agentToken)).send({workspaceId: String(workspace.id), name: 'Project', remoteUrl: 'file:///tmp/remote.git', localKey: '/clone', branch: 'main', headSha: 'abc', remoteHeadSha: 'abc'}).expect(200)).body;

    const refresh = (await request(app).post(`/api/workspaces/${workspace.id}/refresh`).set(auth(user.token)).expect(201)).body;
    expect((await request(app).get('/api/agents/refresh-requests').set(auth(agent.agentToken)).expect(200)).body[0].id).toBe(refresh.id);
    await request(app).post(`/api/agents/refresh-requests/${refresh.id}/claim`).set(auth(agent.agentToken)).expect(200);
    await request(app).post(`/api/agents/refresh-requests/${refresh.id}/complete`).set(auth(agent.agentToken)).send({repositoriesFound: 2}).expect(200);
    expect((await request(app).get(`/api/workspaces/${workspace.id}/refresh`).set(auth(user.token)).expect(200)).body[0]).toMatchObject({status: 'completed', repositories_found: 2});

    const pending = (await request(app).post('/api/pushes/pending').set(auth(agent.agentToken)).send({repositoryId: repo.id, eventKey: 'push-1', remoteName: 'origin', remoteUrl: 'file:///tmp/remote.git', ref: 'refs/heads/main', expectedSha: 'abc', occurredAt: new Date().toISOString()}).expect(201)).body;
    expect((await request(app).get('/api/agents/pushes').set(auth(agent.agentToken)).expect(200)).body[0].id).toBe(pending.id);
    expect((await request(app).post(`/api/agents/pushes/${pending.id}/complete`).set(auth(agent.agentToken)).send({status: 'unconfirmed'}).expect(200)).body.retrying).toBe(true);
    expect((await request(app).get('/api/agents/pushes').set(auth(agent.agentToken)).expect(200)).body).toEqual([]);
    db.prepare("UPDATE pending_pushes SET attempts=2,next_check_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(pending.id);
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
    expect((await request(app).get('/api/workspaces').set(auth(user.token)).expect(200)).body).toEqual([]);
  });

  it('binds agents and report work to one workspace and revokes them on member removal', async () => {
    db = openDb(':memory:');
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
