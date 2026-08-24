import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {scanWatchedRoots} from '../packages/cli/src/agent.js';
import {type Config, loadConfig} from '../packages/cli/src/config.js';

const git = (repo: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {...process.env, ...env},
}).trim();

const commitAt = (repo: string, message: string, date: Date) => {
  fs.writeFileSync(path.join(repo, 'history.txt'), `${message}\n`, {flag: 'a'});
  git(repo, ['add', '.']);
  const timestamp = date.toISOString();
  git(repo, ['commit', '-m', message], {GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp});
  return git(repo, ['rev-parse', 'HEAD']);
};

describe('repository history refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRACEMINI_HOME;
  });

  it('imports 90 days first, then imports newly reachable commits even when their timestamp is older', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-history-refresh-'));
    const repo = path.join(temp, 'repo');
    const state = path.join(temp, 'state');
    fs.mkdirSync(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'qa@example.test']);
    git(repo, ['config', 'user.name', 'QA']);
    git(repo, ['remote', 'add', 'origin', 'https://example.test/team/repo.git']);
    commitAt(repo, 'outside initial window', new Date(Date.now() - 100 * 24 * 60 * 60_000));
    const initialSha = commitAt(repo, 'inside initial window', new Date(Date.now() - 10 * 24 * 60 * 60_000));

    const activities: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/repositories/register') {
        return new Response(JSON.stringify({id: 71, name: 'repo', normalized_remote: 'example.test/team/repo'}), {status: 200, headers: {'content-type': 'application/json'}});
      }
      if (url.pathname === '/api/activity') {
        activities.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({accepted: true}), {status: 202, headers: {'content-type': 'application/json'}});
      }
      return new Response(JSON.stringify({error: `unexpected ${url.pathname}`}), {status: 404, headers: {'content-type': 'application/json'}});
    }));

    process.env.TRACEMINI_HOME = state;
    const config: Config = {
      serverUrl: 'http://tracemini.test',
      agentToken: 'test-device-token',
      workspaceId: 9,
      watchedPaths: [temp],
      clones: [],
      reporter: 'codex',
      pollMs: 2000,
    };

    expect(await scanWatchedRoots(config)).toBe(1);
    expect(activities.map(event => event.data.commitSha)).toEqual([initialSha]);
    const firstHeads = config.clones[0].historyHeads;
    expect(firstHeads).toContain(initialSha);
    expect(loadConfig().clones[0].historyHeads).toEqual(firstHeads);

    activities.length = 0;
    const laterSha = commitAt(repo, 'discovered after first refresh with an older timestamp', new Date(Date.now() - 20 * 24 * 60 * 60_000));
    expect(await scanWatchedRoots(config)).toBe(1);
    expect(activities.map(event => event.data.commitSha)).toEqual([laterSha]);
    expect(config.clones[0].historyHeads).toContain(laterSha);

    fs.rmSync(temp, {recursive: true, force: true});
  }, 15_000);
});
