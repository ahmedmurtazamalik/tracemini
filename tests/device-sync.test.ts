import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../apps/server/src/app.js';
import {openTestDb} from '../apps/server/src/test-db.js';
import type {DB} from '../apps/server/src/db.js';

const authorization = (token: string) => ({authorization: `Bearer ${token}`});
const tokenFrom = (command: string) => decodeURIComponent(command.match(/--install-token\s+'([^']+)'/)?.[1] || command.match(/\/api\/installers\/linux\/([^']+)/)?.[1] || '');
const execFileAsync = promisify(execFile);

let db: DB;
afterEach(async () => {
  await db?.close();
  db = undefined as unknown as DB;
});

describe('existing CLI device sync', () => {
  it('generates a sync command and securely replaces the old device credential', async () => {
    db = await openTestDb();
    const app = createApp(db);

    const oldAccount = (await request(app).post('/api/auth/register').send({
      name: 'Old account', email: 'old-device@example.test', password: 'password123',
    }).expect(201)).body;
    const oldWorkspace = (await request(app).get('/api/workspaces').set(authorization(oldAccount.token)).expect(200)).body[0];
    const oldDevice = (await request(app).post('/api/agents/register').set(authorization(oldAccount.token)).send({machineName: 'existing-laptop'}).expect(201)).body;
    await request(app).post('/api/agents/workspace').set(authorization(oldDevice.token)).send({workspaceId: String(oldWorkspace.id)}).expect(200);

    const newAccount = (await request(app).post('/api/auth/register').send({
      name: 'New account', email: 'new-device@example.test', password: 'password123',
    }).expect(201)).body;
    const newWorkspace = (await request(app).get('/api/workspaces').set(authorization(newAccount.token)).expect(200)).body[0];
    const installation = (await request(app).post('/api/agents/installations').set(authorization(newAccount.token)).send({workspaceId: newWorkspace.id}).expect(201)).body;

    expect(installation.syncCommand).toContain('curl --fail');
    expect(installation.syncCommand).not.toContain('| sh');
    expect(installation.syncCommand).toBe(installation.installCommand);
    const setupToken = tokenFrom(installation.syncCommand);
    expect(setupToken).not.toBe('');

    const synced = (await request(app)
      .post('/api/agents/install/exchange')
      .set(authorization(oldDevice.token))
      .send({installToken: setupToken, machineName: 'existing-laptop'})
      .expect(201)).body;

    await request(app).get('/api/agents/status').set(authorization(oldDevice.token)).expect(401);
    expect((await request(app).get('/api/agents/status').set(authorization(synced.agentToken)).expect(200)).body)
      .toMatchObject({id: synced.agentId, workspaceId: newWorkspace.id, machineName: 'existing-laptop'});
  });

  it('re-pairs the installed CLI, clears stale server-bound state, and restarts its service', async () => {
    execFileSync('npm', ['run', 'build', '-w', '@tracemini/cli'], {cwd: path.resolve('.'), stdio: 'ignore'});
    db = await openTestDb();
    const app = createApp(db);
    const server = app.listen(0);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-sync-'));
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
      const origin = `http://127.0.0.1:${address.port}`;

      const oldAccount = (await request(origin).post('/api/auth/register').send({name: 'Old', email: 'cli-old@example.test', password: 'password123'}).expect(201)).body;
      const oldDevice = (await request(origin).post('/api/agents/register').set(authorization(oldAccount.token)).send({machineName: 'sync-laptop'}).expect(201)).body;
      const newAccount = (await request(origin).post('/api/auth/register').send({name: 'New', email: 'cli-new@example.test', password: 'password123'}).expect(201)).body;
      const newWorkspace = (await request(origin).get('/api/workspaces').set(authorization(newAccount.token)).expect(200)).body[0];
      const installation = (await request(origin).post('/api/agents/installations').set(authorization(newAccount.token)).send({workspaceId: newWorkspace.id}).expect(201)).body;

      const state = path.join(temporary, '.tracemini');
      const fakeBin = path.join(temporary, 'bin');
      fs.mkdirSync(state, {recursive: true});
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({
        serverUrl: origin, agentToken: oldDevice.token, agentId: oldDevice.agentId, workspaceId: 1,
        watchedPaths: ['/work/project'], clones: [{path: '/work/project', repositoryId: 99, normalizedRemote: 'old/repo', name: 'repo'}],
        reporter: 'codex', pollMs: 2000,
      }));
      fs.writeFileSync(path.join(state, 'queue.json'), JSON.stringify([{eventKey: 'old-event'}]));
      fs.writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACEMINI_HOME/systemctl.log"\n', {mode: 0o755});

      const result = await execFileAsync('/bin/sh', ['-c', installation.syncCommand], {
        cwd: path.resolve('.'),
        env: {...process.env, HOME: temporary, TRACEMINI_HOME: state, PATH: `${fakeBin}:${process.env.PATH}`},
      });

      const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
      expect(result.stdout).toContain('installed and started');
      expect(config).toMatchObject({serverUrl: origin, workspaceId: newWorkspace.id, watchedPaths: ['/work/project'], clones: []});
      expect(config.agentToken).not.toBe(oldDevice.token);
      expect(JSON.parse(fs.readFileSync(path.join(state, 'queue.json'), 'utf8'))).toEqual([]);
      const serviceLog = fs.readFileSync(path.join(state, 'systemctl.log'), 'utf8');
      expect(serviceLog.trim().split('\n')[0]).toBe('--user stop tracemini.service');
      expect(serviceLog).toContain('--user enable tracemini.service');
      expect(serviceLog).toContain('--user restart tracemini.service');
      await request(origin).get('/api/agents/status').set(authorization(oldDevice.token)).expect(401);
      const status = (await request(origin).get('/api/agents/status').set(authorization(config.agentToken)).expect(200)).body;
      expect(status).toMatchObject({workspaceId: newWorkspace.id});
      expect(status.machineName).toBeTruthy();
    } finally {
      server.close();
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });
});
