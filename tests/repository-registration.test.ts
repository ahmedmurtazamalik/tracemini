import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {registerWatchedRoots} from '../packages/cli/src/agent.js';
import {type Config, loadConfig, saveConfig} from '../packages/cli/src/config.js';

const createRepository = (root: string, name: string) => {
  const repository = path.join(root, name);
  fs.mkdirSync(repository);
  execFileSync('git', ['init'], {cwd: repository});
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/team/${name}.git`], {cwd: repository});
};

describe('repository registration responsiveness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRACEMINI_HOME;
  });

  it('registers independent repositories concurrently', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-register-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    createRepository(temporary, 'one');
    createRepository(temporary, 'two');
    let active = 0;
    let maximumActive = 0;
    let id = 70;
    vi.stubGlobal('fetch', vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      id += 1;
      return Response.json({id, name: `repo-${id}`, normalized_remote: `example.test/team/repo-${id}`});
    }));
    const config: Config = {
      serverUrl: 'http://tracemini.test',
      agentToken: 'agent-token',
      agentId: 4,
      workspaceId: 8,
      watchedPaths: [temporary, path.join(temporary, 'one')],
      clones: [],
      reporter: 'codex',
      pollMs: 2000,
    };
    saveConfig(config);

    expect(await registerWatchedRoots(config)).toBe(2);
    expect(maximumActive).toBe(2);
    expect(config.clones).toHaveLength(2);
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('does not install hooks or clones after the device binding changes in flight', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-register-race-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    createRepository(temporary, 'one');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const requestStarted = new Promise<void>(resolve => { requested = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      requested();
      await blocked;
      return Response.json({id: 71, name: 'one', normalized_remote: 'example.test/team/one'});
    }));
    const stale: Config = {serverUrl: 'https://old.example', agentToken: 'old-token', agentId: 4, workspaceId: 8, watchedPaths: [temporary], clones: [], reporter: 'codex', pollMs: 2000};
    saveConfig(stale);

    const registration = registerWatchedRoots(stale);
    await requestStarted;
    saveConfig({...stale, serverUrl: 'https://new.example', agentToken: 'new-token', watchedPaths: [], clones: []}, {replaceRepositoryState: true});
    release();

    expect(await registration).toBe(0);
    expect(loadConfig().clones).toEqual([]);
    expect(fs.existsSync(path.join(temporary, 'one', '.git', 'hooks', 'post-commit'))).toBe(false);
    fs.rmSync(temporary, {recursive: true, force: true});
  });
});
