import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

export function discover(root: string) {
  const found: string[] = [];
  const excluded = new Set(['node_modules', '.cache', '.local', '.npm', '.pnpm-store', '.cargo', '.rustup', '.hermes']);
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, {withFileTypes: true}); } catch { return; }
    if (entries.some(entry => entry.name === '.git')) {
      found.push(directory);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name)) walk(path.join(directory, entry.name));
    }
  };
  walk(path.resolve(root));
  return found;
}

export function normalizeRemote(value: string) {
  let normalized = value.trim().replace(/\\/g, '/').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  const scp = normalized.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !normalized.includes('://')) normalized = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(normalized);
      normalized = url.protocol === 'file:' ? `file://${url.pathname}` : `${url.hostname}${url.pathname}`;
    } catch {}
  }
  return normalized.replace(/^\/+/, '').toLowerCase();
}

export type RepositoryState = {branch: string; headSha: string; remoteHeadSha?: string; headAction?: string};

export function readRepositoryState(repo: string): RepositoryState {
  const branch = git(repo, ['branch', '--show-current']) || '(detached)';
  let headSha = '';
  try { headSha = git(repo, ['rev-parse', 'HEAD']); } catch {}
  let remoteHeadSha: string | undefined;
  try { remoteHeadSha = git(repo, ['rev-parse', '@{upstream}']); } catch {}
  let headAction: string | undefined;
  try { headAction = git(repo, ['reflog', '-1', '--format=%gs', 'HEAD']); } catch {}
  return {branch, headSha, remoteHeadSha, headAction};
}

export function repositoryNameFromRemote(value: string) {
  const withoutSuffix = value.trim().replace(/\\/g, '/').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  return decodeURIComponent(withoutSuffix.split('/').pop()?.split(':').pop() || '');
}

export function inspectRepo(repo: string) {
  const remoteUrl = git(repo, ['remote', 'get-url', 'origin']);
  const remoteName = repositoryNameFromRemote(remoteUrl);
  const matchingLocalName = path.resolve(repo).split(path.sep).reverse().find(segment => segment.toLowerCase() === remoteName.toLowerCase());
  return {
    path: path.resolve(repo),
    name: matchingLocalName || remoteName || path.basename(repo),
    remoteUrl,
    normalizedRemote: normalizeRemote(remoteUrl),
    ...readRepositoryState(repo),
  };
}

export function observeRepositoryState(previous: RepositoryState, current: RepositoryState) {
  const sameBranch = previous.branch === current.branch;
  const localMoved = previous.headSha !== current.headSha;
  const remoteMoved = previous.remoteHeadSha !== current.remoteHeadSha;
  const converged = Boolean(current.remoteHeadSha && current.headSha === current.remoteHeadSha);
  const locallyCreatedCommit = /^(commit|commit \(amend\)|cherry-pick|revert):/i.test(current.headAction || '');
  return {event: sameBranch && localMoved && remoteMoved && converged && !locallyCreatedCommit ? 'pull' as const : undefined, current};
}

function commitDataAt(repo: string, ref: string) {
  const raw = git(repo, ['show', '-s', '--format=%H%n%s%n%aI%n%an%n%ae', ref]).split('\n');
  const stat = git(repo, ['show', '--format=', '--numstat', ref]).split('\n').filter(Boolean);
  return {
    commitSha: raw[0], message: raw[1], commitTimestamp: raw[2], authorName: raw[3], authorEmail: raw[4],
    branch: git(repo, ['branch', '--show-current']) || '(detached)',
    filesChanged: stat.length,
    insertions: stat.reduce((sum, line) => sum + (parseInt(line.split('\t')[0]) || 0), 0),
    deletions: stat.reduce((sum, line) => sum + (parseInt(line.split('\t')[1]) || 0), 0),
    changedFiles: stat.map(line => line.split('\t').slice(2).join('\t')),
  };
}

export function commitData(repo: string) {
  return commitDataAt(repo, 'HEAD');
}

export function commitHistory(repo: string, since: string, until: string) {
  const commits = git(repo, ['log', '--all', '--reverse', '--format=%H', `--since=${since}`, `--until=${until}`]).split('\n').filter(Boolean);
  return commits.map(commit => commitDataAt(repo, commit));
}

export function historyHeads(repo: string) {
  const refs = git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']).split('\n').filter(Boolean);
  try { refs.push(git(repo, ['rev-parse', 'HEAD'])); } catch {}
  return [...new Set(refs.filter(ref => {
    try { git(repo, ['cat-file', '-e', `${ref}^{commit}`]); return true; } catch { return false; }
  }))].sort();
}

export function commitHistoryAfterHeads(repo: string, previousHeads: string[]) {
  const validHeads = previousHeads.filter(ref => {
    try { git(repo, ['cat-file', '-e', `${ref}^{commit}`]); return true; } catch { return false; }
  });
  if (!validHeads.length) return undefined;
  const commits = git(repo, ['rev-list', '--all', '--reverse', '--not', ...validHeads]).split('\n').filter(Boolean);
  return commits.map(commit => commitDataAt(repo, commit));
}

export function stagedData(repo: string) {
  const lines = git(repo, ['diff', '--cached', '--numstat']).split('\n').filter(Boolean);
  return {
    branch: git(repo, ['branch', '--show-current']) || '(detached)',
    filesChanged: lines.length,
    insertions: lines.reduce((sum, line) => sum + (parseInt(line.split('\t')[0]) || 0), 0),
    deletions: lines.reduce((sum, line) => sum + (parseInt(line.split('\t')[1]) || 0), 0),
    changedFiles: lines.map(line => line.split('\t').slice(2).join('\t')),
  };
}

export type PushIntent = {remoteName: string; remoteUrl: string; ref: string; expectedSha: string};

export function parsePrePush(remoteName: string, remoteUrl: string, stdin: string): PushIntent[] {
  return stdin.trim().split('\n').filter(Boolean).flatMap(line => {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localRef || !localSha || !remoteRef || /^0+$/.test(localSha)) return [];
    return [{remoteName, remoteUrl, ref: remoteRef, expectedSha: localSha}];
  });
}

export function confirmPush(intent: PushIntent): {status: 'confirmed' | 'unconfirmed'; observedSha?: string} {
  try {
    const output = execFileSync('git', ['ls-remote', '--refs', intent.remoteUrl, intent.ref], {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'},
    }).trim();
    const observedSha = output.split(/\s+/)[0];
    return observedSha === intent.expectedSha ? {status: 'confirmed', observedSha} : {status: 'unconfirmed', observedSha: observedSha || undefined};
  } catch {
    return {status: 'unconfirmed'};
  }
}

const hooks = ['post-commit', 'post-checkout', 'post-merge', 'post-rewrite', 'pre-push'];
export function installHooks(repo: string) {
  const hooksDir = git(repo, ['rev-parse', '--git-path', 'hooks']);
  const absolute = path.isAbsolute(hooksDir) ? hooksDir : path.join(repo, hooksDir);
  fs.mkdirSync(absolute, {recursive: true});
  for (const hook of hooks) {
    const target = path.join(absolute, hook);
    const original = `${target}.tracemini-original`;
    if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes('TraceMini managed hook') && !fs.existsSync(original)) fs.renameSync(target, original);
    const type = hook === 'post-commit' ? 'commit' : hook === 'post-checkout' ? 'branch' : hook === 'post-merge' ? 'merge' : hook === 'post-rewrite' ? 'rewrite' : 'push';
    const script = hook === 'pre-push'
      ? `#!/bin/sh\n# TraceMini managed hook\noriginal="$0.tracemini-original"\ninput="$(mktemp "${'${TMPDIR:-/tmp}'}/tracemini-push.XXXXXX")" || exit 1\ntrap 'rm -f "$input"' EXIT HUP INT TERM\ncat >"$input"\nif [ -x "$original" ]; then "$original" "$@" <"$input" || exit $?; fi\ncommand -v tracemini >/dev/null 2>&1 && tracemini event --repo "$(git rev-parse --show-toplevel)" --type ${type} --hook ${hook} "$@" <"$input" >/dev/null 2>&1 || true\nexit 0\n`
      : `#!/bin/sh\n# TraceMini managed hook\noriginal="$0.tracemini-original"\nif [ -x "$original" ]; then "$original" "$@" || exit $?; fi\ncommand -v tracemini >/dev/null 2>&1 && tracemini event --repo "$(git rev-parse --show-toplevel)" --type ${type} --hook ${hook} "$@" >/dev/null 2>&1 || true\nexit 0\n`;
    fs.writeFileSync(target, script, {mode: 0o755});
  }
  return hooks;
}

export function removeHooks(repo: string) {
  const hooksDir = git(repo, ['rev-parse', '--git-path', 'hooks']);
  const absolute = path.isAbsolute(hooksDir) ? hooksDir : path.join(repo, hooksDir);
  const removed: string[] = [];
  for (const hook of hooks) {
    const target = path.join(absolute, hook);
    const original = `${target}.tracemini-original`;
    if (!fs.existsSync(target) || !fs.readFileSync(target, 'utf8').includes('TraceMini managed hook')) continue;
    fs.rmSync(target);
    if (fs.existsSync(original)) fs.renameSync(original, target);
    removed.push(hook);
  }
  return removed;
}
