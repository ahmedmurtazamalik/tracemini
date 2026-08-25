import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig, loadQueue, mutateQueue, saveConfig, saveQueue, type Config, updateConfig} from '../packages/cli/src/config.js';
import {confirmPushForClone, flush, prioritizeCandidatePaths, processRepositorySelections, publishRepositoryCandidates, reconcileConfiguredCloneIdentities, scanWatchedRoots, traceRepository, verifyRepositorySelection} from '../packages/cli/src/agent.js';
import {inspectRepo, normalizeRemote, repositoryFingerprint} from '../packages/cli/src/git.js';

let temporary = '';
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRACEMINI_HOME;
  delete process.env.TRACEMINI_QUEUE_LEASE_MS;
  if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
});

const createRepo = (root: string, name: string) => {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: repo});
  execFileSync('git', ['config', 'user.name', 'Selection Test'], {cwd: repo});
  execFileSync('git', ['config', 'user.email', 'selection@example.test'], {cwd: repo});
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], {cwd: repo});
  execFileSync('git', ['commit', '-qm', `Create ${name}`], {cwd: repo});
  return repo;
};

describe('device repository selection', () => {
  it('reserves the bounded candidate list for configured clones before discoveries', () => {
    expect(prioritizeCandidatePaths(['/trusted/outside'], Array.from({length: 500}, (_, index) => `/discovered/${index}`))).toEqual([
      '/trusted/outside',
      ...Array.from({length: 499}, (_, index) => `/discovered/${index}`),
    ]);
  });

  it('persists an empty watched root and discovers repositories created there later', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-watched-root-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const watchedRoot = path.join(temporary, 'external-projects');
    const ordinaryRoot = path.join(temporary, 'ordinary-home');
    fs.mkdirSync(watchedRoot);
    fs.mkdirSync(ordinaryRoot);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const candidateBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (new URL(url).pathname === '/api/agents/repository-candidates') candidateBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    expect(await scanWatchedRoots(config, [watchedRoot])).toBe(0);
    expect(loadConfig().watchedPaths).toContain(watchedRoot);
    const future = createRepo(watchedRoot, 'future');
    await publishRepositoryCandidates(loadConfig(), ordinaryRoot);
    expect(candidateBodies.at(-1).repositories).toEqual(expect.arrayContaining([expect.objectContaining({localKey: future, traced: false})]));
    const info = inspectRepo(future);
    expect(() => verifyRepositorySelection(loadConfig(), {local_key: future, normalized_remote: normalizeRemote(info.remoteUrl)}, ordinaryRoot)).not.toThrow();
    expect(() => verifyRepositorySelection({...loadConfig(), watchedPaths: []}, {local_key: future, normalized_remote: normalizeRemote(info.remoteUrl)})).toThrow('outside the approved discovery root');
  });

  it('does not resurrect watched roots from a stale workspace binding', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-scan-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const oldRoot = path.join(temporary, 'old-root');
    fs.mkdirSync(oldRoot);
    const stale: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [oldRoot], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(stale, {replaceCollections: true});
    saveConfig({...stale, workspaceId: 2, watchedPaths: [], clones: []}, {replaceCollections: true});

    expect(await scanWatchedRoots(stale, [oldRoot])).toBe(0);
    expect(loadConfig()).toMatchObject({workspaceId: 2, watchedPaths: [], clones: []});
  });

  it('drops legacy queue entries instead of guessing among duplicate clone paths', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-legacy-queue-'));
    process.env.TRACEMINI_HOME = temporary;
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', watchedPaths: [], clones: [
      {path: '/clone/one', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo'},
      {path: '/clone/two', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo'},
    ], reporter: 'hermes', pollMs: 2000};
    saveQueue([{eventKey: 'legacy', repositoryId: 7, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await flush(config)).toEqual({sent: 0, pending: 0});
    expect(loadQueue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not resurrect an in-flight failed event after its clone is deselected', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-queue-deselect-'));
    process.env.TRACEMINI_HOME = temporary;
    const clone = {path: '/clone/selected', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo', repositoryFingerprint: 'a'.repeat(64)};
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', watchedPaths: [], clones: [clone], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'in-flight', repositoryId: 7, localKey: clone.path, identityFingerprint: clone.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { requested(); await blocked; throw new Error('offline'); }));
    const flushing = flush(config);
    await started;
    expect(loadQueue()).toEqual([expect.objectContaining({eventKey: 'in-flight', claimId: expect.any(String), claimedAt: expect.any(Number)})]);
    updateConfig(current => { current.clones = []; });
    mutateQueue(queue => queue.splice(0));
    release();
    await flushing;
    expect(loadQueue()).toEqual([]);
  });

  it('recovers a durably claimed event after a crashed flush lease expires', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-queue-recovery-'));
    process.env.TRACEMINI_HOME = temporary;
    process.env.TRACEMINI_QUEUE_LEASE_MS = '1000';
    const clone = {path: '/clone/selected', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo', repositoryFingerprint: 'a'.repeat(64)};
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', watchedPaths: [], clones: [clone], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'crashed', repositoryId: 7, localKey: clone.path, identityFingerprint: clone.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0, claimId: 'dead-process', claimedAt: Date.now() - 2000}]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ok: true}), {status: 201})));
    expect(await flush(config)).toEqual({sent: 1, pending: 0});
    expect(loadQueue()).toEqual([]);
  });

  it('fails closed when a selected repository path is replaced', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-replaced-repo-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(temporary, 'selected');
    const originalFingerprint = repositoryFingerprint(repo);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [temporary], clones: [{path: repo, repositoryId: 7, normalizedRemote: normalizeRemote(`local-device-1:${repo}`), name: 'selected', repositoryFingerprint: originalFingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    fs.writeFileSync(path.join(repo, 'next.txt'), 'next');
    execFileSync('git', ['add', '.'], {cwd: repo});
    execFileSync('git', ['commit', '-qm', 'normal activity'], {cwd: repo});
    expect(repositoryFingerprint(repo)).toBe(originalFingerprint);
    fs.rmSync(path.join(repo, '.git'), {recursive: true, force: true});
    execFileSync('git', ['init', '-q'], {cwd: repo});
    const candidateBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      candidateBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    await reconcileConfiguredCloneIdentities(config, new Map());
    expect(loadConfig().clones).toEqual([]);
    expect(candidateBodies).toEqual([expect.objectContaining({repositories: [expect.objectContaining({localKey: repo, traced: false, identityChanged: true})]})]);
  });

  it('rejects push confirmation when the repository is replaced during remote verification', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-push-identity-race-'));
    const repo = createRepo(temporary, 'selected');
    const fingerprint = repositoryFingerprint(repo);
    const clone = {path: repo, repositoryId: 7, normalizedRemote: 'local/repo', name: 'selected', repositoryFingerprint: fingerprint};
    expect(() => confirmPushForClone(clone, {repository_fingerprint: fingerprint}, () => {
      fs.rmSync(path.join(repo, '.git'), {recursive: true, force: true});
      execFileSync('git', ['init', '-q'], {cwd: repo});
      return {status: 'confirmed' as const, observedSha: 'abc'};
    })).toThrow('repository identity changed');
  });

  it('fails closed when a repository is replaced during registration', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-registration-race-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(temporary, 'selected');
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [temporary], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === '/api/repositories/register') {
        fs.rmSync(path.join(repo, '.git'), {recursive: true, force: true});
        execFileSync('git', ['init', '-q'], {cwd: repo});
        execFileSync('git', ['config', 'user.name', 'Replacement'], {cwd: repo});
        execFileSync('git', ['config', 'user.email', 'replacement@example.test'], {cwd: repo});
        fs.writeFileSync(path.join(repo, 'replacement.txt'), 'replacement');
        execFileSync('git', ['add', '.'], {cwd: repo});
        execFileSync('git', ['commit', '-qm', 'replacement'], {cwd: repo});
        return new Response(JSON.stringify({id: 7, name: 'selected', normalized_remote: normalizeRemote(`local-device-1:${repo}`)}), {status: 200});
      }
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    await expect(traceRepository(config, repo)).rejects.toThrow('repository identity changed');
    expect(config.clones).toEqual([]);
    expect(paths).not.toContain('/api/activity');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('rejects a discovered path that is later redirected outside the discovery root', () => {
    temporary = fs.mkdtempSync(path.join(os.homedir(), '.tracemini-repository-selection-test-'));
    const root = path.join(temporary, 'root');
    const outside = path.join(temporary, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    execFileSync('git', ['init'], {cwd: outside, stdio: 'ignore'});
    const target = outside;
    const localKey = path.join(root, 'candidate');
    fs.symlinkSync(target, localKey, 'dir');
    expect(() => verifyRepositorySelection({clones: []} as any, {local_key: localKey, normalized_remote: normalizeRemote(`local:${localKey}`)}, root)).toThrow('outside the approved discovery root');
  });

  it('publishes every discoverable repo and applies a trace selection', async () => {
    temporary = fs.mkdtempSync(path.join(os.homedir(), '.tracemini-repository-selection-test-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const projects = path.join(temporary, 'projects');
    const selected = createRepo(projects, 'selected');
    const available = createRepo(projects, 'available');
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [selected, available], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const candidateBodies: any[] = [];
    let desiredTraced = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const pathname = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (pathname === '/api/agents/repository-candidates') candidateBodies.push(body);
      if (pathname === '/api/agents/repository-selections' && (!init.method || init.method === 'GET')) return new Response(JSON.stringify([{id: 9, revision: 1, local_key: available, name: 'available', remote_url: `local:${available}`, normalized_remote: normalizeRemote(`local:${available}`), desired_traced: desiredTraced, traced: !desiredTraced}]), {status: 200});
      if (pathname === '/api/repositories/register') return new Response(JSON.stringify({id: 77, name: 'available', normalized_remote: `local/${available}`}), {status: 200});
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));

    await publishRepositoryCandidates(config, projects);
    expect(candidateBodies[0].repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({localKey: selected, traced: false}),
      expect.objectContaining({localKey: available, traced: false}),
    ]));

    await processRepositorySelections(config);
    const stored = loadConfig();
    expect(stored.watchedPaths).toEqual([selected, available]);
    expect(stored.clones).toEqual([expect.objectContaining({path: available, repositoryId: 77})]);
    expect(fs.readFileSync(path.join(available, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('TraceMini managed hook');

    desiredTraced = false;
    await processRepositorySelections(stored);
    const stopped = loadConfig();
    expect(stopped.watchedPaths).toContain(available);
    expect(stopped.clones).toEqual([]);
    expect(fs.existsSync(path.join(available, '.git', 'hooks', 'post-commit'))).toBe(false);
  });
});
