import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig, saveConfig} from '../packages/cli/src/config.js';

const originalHome = process.env.TRACEMINI_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.TRACEMINI_HOME;
  else process.env.TRACEMINI_HOME = originalHome;
});

describe('concurrent CLI configuration', () => {
  it('watches the user home directory by default, including existing empty configs', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-default-home-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-user-home-'));
    process.env.TRACEMINI_HOME = state;
    const originalUserHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(loadConfig().watchedPaths).toEqual([fakeHome]);
      fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({watchedPaths: []}));
      expect(loadConfig().watchedPaths).toEqual([fakeHome]);
    } finally {
      if (originalUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalUserHome;
      fs.rmSync(state, {recursive: true, force: true});
      fs.rmSync(fakeHome, {recursive: true, force: true});
    }
  });

  it('serializes real cross-process config writers without losing updates', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-processes-'));
    process.env.TRACEMINI_HOME = home;
    const gate = path.join(home, 'gate');
    fs.mkdirSync(path.join(home, 'config.lock'), {mode: 0o700});
    fs.writeFileSync(path.join(home, 'config.lock', 'owner'), '2147483647', {mode: 0o600});
    const worker = fileURLToPath(new URL('./fixtures/config-writer.ts', import.meta.url));
    const roots = Array.from({length: 16}, (_, index) => `/work/repo-${index}`);
    const children = roots.map((root, index) => spawn(process.execPath, ['--import', 'tsx', worker, root, gate, path.join(home, `ready-${index}`)], {
      env: {...process.env, TRACEMINI_HOME: home}, stdio: 'ignore',
    }));
    while (roots.some((_, index) => !fs.existsSync(path.join(home, `ready-${index}`)))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fs.writeFileSync(gate, 'go');
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(`config writer exited ${code}`))))));

    expect(loadConfig().watchedPaths.sort()).toEqual([os.homedir(), ...roots].sort());
    fs.rmSync(home, {recursive: true, force: true});
  }, 20_000);

  it('does not let a running agent overwrite roots and clones added by the watch command', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), serverUrl: 'http://localhost:43118', workspaceId: 1, agentToken: 'agent'});

    const staleAgentConfig = loadConfig();
    const watchConfig = loadConfig();
    watchConfig.watchedPaths.push('/tmp/watched');
    watchConfig.clones.push({path: '/tmp/watched/repo', repositoryId: 7, normalizedRemote: 'file:///tmp/remote', name: 'repo'});
    saveConfig(watchConfig);

    saveConfig(staleAgentConfig);

    expect(loadConfig()).toMatchObject({
      watchedPaths: [os.homedir(), '/tmp/watched'],
      clones: [{path: '/tmp/watched/repo', repositoryId: 7}],
    });
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('preserves interactive scalar settings when a stale background scan saves discoveries', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    const staleAgent = {...loadConfig(), workspaceId: 1, agentId: 11};
    saveConfig(staleAgent);
    saveConfig({...loadConfig(), workspaceId: 2, agentId: 22});

    saveConfig(staleAgent, {preserveCurrentScalars: true});

    expect(loadConfig()).toMatchObject({workspaceId: 2, agentId: 22});
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('persists background repository state without changing its current binding', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    const clone = {path: '/work/repo', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo', headSha: 'old'};
    saveConfig({...loadConfig(), workspaceId: 2, agentId: 22, clones: [clone]});

    saveConfig({...loadConfig(), workspaceId: 1, agentId: 11, clones: [{...clone, headSha: 'new'}]}, {preserveCurrentScalars: true});

    expect(loadConfig()).toMatchObject({workspaceId: 2, agentId: 22, clones: [{repositoryId: 7, headSha: 'new'}]});
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('does not resurrect an interactive credential deletion', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), userToken: 'temporary-user-token', workspaceId: 1});
    const staleAgent = loadConfig();
    const exchanged = loadConfig();
    delete exchanged.userToken;
    exchanged.agentToken = 'installed-agent-token';
    saveConfig(exchanged);
    saveConfig(staleAgent, {preserveCurrentScalars: true});

    expect(loadConfig()).toMatchObject({agentToken: 'installed-agent-token', workspaceId: 1});
    expect(loadConfig().userToken).toBeUndefined();
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('recovers a config lock left by a dead process', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    fs.mkdirSync(path.join(home, 'config.lock'), {mode: 0o700});
    fs.writeFileSync(path.join(home, 'config.lock', 'owner'), '2147483647', {mode: 0o600});

    saveConfig({...loadConfig(), workspaceId: 9});

    expect(loadConfig().workspaceId).toBe(9);
    expect(fs.existsSync(path.join(home, 'config.lock'))).toBe(false);
    fs.rmSync(home, {recursive: true, force: true});
  });
});
