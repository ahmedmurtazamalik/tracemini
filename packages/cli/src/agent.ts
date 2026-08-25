import fs from 'node:fs';
import path from 'node:path';
import {api} from './api.js';
import {type Config, loadConfig, loadQueue, mutateCurrentBinding, saveConfig, saveQueue, eventKey} from './config.js';
import {commitHistory, commitHistoryAfterHeads, confirmPush, discover, git, historyHeads, inspectRepo, installHooks, removeHooks, observeRepositoryState, readRepositoryState, stagedData} from './git.js';
import {CodexRunner, HermesRunner} from './runner.js';

export async function flush(config: Config) {
  const queue = loadQueue();
  const remaining = [];
  for (const event of queue) {
    if (event.nextAttempt > Date.now()) { remaining.push(event); continue; }
    try { await api(config, '/api/activity', {method: 'POST', body: JSON.stringify(event)}); }
    catch { event.attempts++; event.nextAttempt = Date.now() + Math.min(60_000, 1000 * 2 ** event.attempts); remaining.push(event); }
  }
  saveQueue(remaining, config);
  return {sent: queue.length - remaining.length, pending: remaining.length};
}

export async function registerWatchedRoots(config: Config) {
  if (!config.workspaceId) throw new Error('device has no selected workspace');
  const repoPaths = [...new Set(config.watchedPaths.flatMap(root => discover(root)))];
  const discovered = repoPaths.flatMap(repoPath => {
    try { return [inspectRepo(repoPath)]; } catch { return []; }
  });
  const registered = await Promise.all(discovered.map(async info => ({
    info,
    repository: await api<any>(config, '/api/repositories/register', {method: 'POST', body: JSON.stringify({workspaceId: String(config.workspaceId), name: info.name, remoteUrl: info.remoteUrl, localKey: info.path, branch: info.branch, headSha: info.headSha, remoteHeadSha: info.remoteHeadSha})}),
  })));
  let applied = 0;
  for (const {info, repository} of registered) {
    let committed = false;
    try {
      committed = mutateCurrentBinding(config, current => {
        const existing = current.clones.find(clone => clone.path === info.path && clone.repositoryId === repository.id);
        installHooks(info.path);
        current.watchedPaths = [...new Set([...current.watchedPaths, ...config.watchedPaths])];
        current.clones = current.clones.filter(clone => clone.path !== info.path);
        current.clones.push({path: info.path, repositoryId: repository.id, normalizedRemote: repository.normalized_remote, name: repository.name, branch: info.branch, headSha: info.headSha, remoteHeadSha: info.remoteHeadSha, historyHeads: existing?.historyHeads});
      });
    } catch (error) {
      try { removeHooks(info.path); } catch {}
      throw error;
    }
    if (!committed) break;
    applied += 1;
  }
  return applied;
}

export async function syncHistory(config: Config, days = 90) {
  let commits = 0;
  let repositories = 0;
  for (const clone of config.clones) {
    const scanStartedAt = new Date().toISOString();
    const currentHistoryHeads = historyHeads(clone.path);
    const incrementalHistory = clone.historyHeads?.length
      ? commitHistoryAfterHeads(clone.path, clone.historyHeads)
      : undefined;
    const history = incrementalHistory ?? commitHistory(
      clone.path,
      new Date(Date.parse(scanStartedAt) - days * 24 * 60 * 60_000).toISOString(),
      scanStartedAt,
    );
    for (let offset = 0; offset < history.length; offset += 8) {
      await Promise.all(history.slice(offset, offset + 8).map(data =>
        api(config, '/api/activity', {method: 'POST', body: JSON.stringify({
          eventKey: eventKey(['commit-history', clone.repositoryId, data.commitSha]),
          repositoryId: clone.repositoryId,
          type: 'commit',
          occurredAt: data.commitTimestamp,
          data: {...data, importedFromHistory: true},
        })}),
      ));
    }
    clone.historyHeads = currentHistoryHeads;
    commits += history.length;
    repositories++;
  }
  saveConfig(config, {preserveCurrentScalars: true});
  return {repositories, commits};
}

async function processPushes(config: Config) {
  const pushes = await api<any[]>(config, '/api/agents/pushes');
  const configuredDelay = Number(process.env.TRACEMINI_PUSH_CONFIRM_DELAY_MS);
  const confirmationDelayMs = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 8_000;
  for (const push of pushes) {
    // pre-push runs before Git contacts the remote. Give the push time to finish
    // rather than permanently marking a successful in-flight push unconfirmed.
    if (Date.now() - Date.parse(push.occurred_at) < confirmationDelayMs) continue;
    const result = confirmPush({remoteName: push.remote_name, remoteUrl: push.remote_url, ref: push.ref, expectedSha: push.expected_sha});
    await api(config, `/api/agents/pushes/${push.id}/complete`, {method: 'POST', body: JSON.stringify(result)});
  }
}

const sensitiveLabel = /(?:pass(?:word|wd|phrase)?|pwd|token|secret|credential|api[_-]?key|access[_-]?key(?:[_-]?id)?|consumer[_-]?key|client[_-]?(?:secret|key)|private[_-]?key|authorization|database[_-]?url|connection[_-]?string)/i;

function redactSensitiveDiff(text: string) {
  let privateKey = false;
  let redactNextValue = false;
  const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
  const recognizableToken = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/;
  return text.split('\n').map(line => {
    const prefix = /^[+\- ]/.test(line) ? line[0] : '';
    if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(line)) privateKey = true;
    if (privateKey) {
      if (/END (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(line)) privateKey = false;
      return `${prefix}[REDACTED PRIVATE KEY]`;
    }
    if (redactNextValue) {
      if (!line.trim()) return line;
      redactNextValue = false;
      return `${prefix}[REDACTED SENSITIVE VALUE]`;
    }
    const sensitive = sensitiveLabel.test(line);
    if (sensitive && /:\s*$/.test(line)) {
      redactNextValue = true;
      return `${prefix}[REDACTED SENSITIVE VALUE]`;
    }
    if (
      credentialUrl.test(line)
      || recognizableToken.test(line)
      || (sensitive && /(?:[:=]|\bBearer\s+)/i.test(line))
    ) return `${prefix}[REDACTED SENSITIVE VALUE]`;
    return line;
  }).join('\n');
}

function redactEvidence(value: unknown, key = ''): unknown {
  if (sensitiveLabel.test(key)) return '[REDACTED SENSITIVE VALUE]';
  if (typeof value === 'string') {
    const redacted = redactSensitiveDiff(value);
    return redacted.includes('[REDACTED ') ? '[REDACTED SENSITIVE VALUE]' : value;
  }
  if (Array.isArray(value)) return value.map(item => redactEvidence(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, redactEvidence(item, field)]));
  return value;
}

export function contextPrompt(context: any, clones: Config['clones']) {
  const grouped = new Map<string, any[]>();
  for (const event of context.events) grouped.set(event.normalized_remote, [...(grouped.get(event.normalized_remote) || []), event]);
  const timezone = context.job.timezone || 'Asia/Karachi';
  const includeDiff = Boolean(context.job.include_diff);
  let text = `Generate a factual Markdown report about engineering contributions for ${context.job.start_date} through ${context.job.end_date} (${timezone}). Use only the supplied Git evidence. Do not modify files.\n\n`;
  text += `Synthesize related work into meaningful contributions: delivered capabilities and outcomes, technical decisions, architecture or implementation work, problems solved, testing and reliability improvements, and demonstrated ownership. Explain engineering significance only where the evidence supports it. Do not structure the report as a commit-by-commit chronology, do not use hashes or line counts as the main narrative, and do not invent impact, collaboration, intent, or test results not supported by evidence. Keep provider and internal pipeline jargon out of the user-facing report.\n\n`;
  text += includeDiff
    ? `Detailed diff excerpts were explicitly enabled. Use the bounded, redacted excerpts to explain implementation behavior while preserving factual grounding.\n\n`
    : `Diff excerpts were not enabled. Do not invent implementation details beyond commit metadata and file statistics.\n\n`;
  if (context.job.custom_prompt) text += `User-requested report structure or emphasis:\n${context.job.custom_prompt}\nFollow this preference unless it conflicts with factual accuracy, supplied evidence, redaction, or read-only operation.\n\n`;
  let diffBudget = 80_000;
  for (const [remote, events] of grouped) {
    const clone = clones.find(item => item.normalizedRemote === remote);
    text += `\n## Evidence: ${events[0].repository_name}\nRepository: ${remote}\nLocal clone: ${clone?.path || 'unavailable'}\n`;
    for (const event of events) {
      const data = event.data || {};
      text += `\n### ${event.type}${data.commitSha ? ` ${String(data.commitSha).slice(0, 12)}` : ''}\n`;
      text += `Timestamp: ${event.occurred_at}\nEvidence:\n${JSON.stringify(redactEvidence(data), null, 2)}\n`;
      if (clone && event.type === 'commit' && data.commitSha) {
        try {
          const args = includeDiff
            ? ['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--unified=3', data.commitSha]
            : ['show', '--stat', '--format=fuller', '--no-ext-diff', data.commitSha];
          let evidence = redactSensitiveDiff(git(clone.path, args));
          const limit = includeDiff ? Math.min(20_000, diffBudget) : 8_000;
          evidence = evidence.slice(0, limit);
          if (includeDiff) diffBudget -= evidence.length;
          text += `\nGit evidence:\n\`\`\`diff\n${evidence}\n\`\`\`\n`;
        } catch { text += '\nGit evidence unavailable for this commit.\n'; }
      }
    }
  }
  return redactSensitiveDiff(text);
}

export async function processJob(config: Config, job: any) {
  await api(config, `/api/agents/jobs/${job.id}/claim`, {method: 'POST'});
  try {
    const context = await api<any>(config, `/api/agents/jobs/${job.id}/context`);
    const cwd = config.clones.find(clone => context.events.some((event: any) => event.normalized_remote === clone.normalizedRemote))?.path || process.cwd();
    const runner = job.reporter === 'hermes' ? new HermesRunner() : new CodexRunner();
    const markdown = await runner.generate(contextPrompt(context, config.clones), cwd);
    await api(config, `/api/agents/jobs/${job.id}/complete`, {method: 'POST', body: JSON.stringify({markdown})});
  } catch (error: any) {
    await api(config, `/api/agents/jobs/${job.id}/fail`, {method: 'POST', body: JSON.stringify({error: String(error.message || error).slice(0, 2000)})});
    throw error;
  }
}

export async function tick(config: Config, indexState: Map<string, {mtime: number; timer?: NodeJS.Timeout}>) {
  await api(config, '/api/agents/heartbeat', {method: 'POST'});
  const jobs = await api<any[]>(config, '/api/agents/jobs');
  if (jobs[0]) await processJob(config, jobs[0]);
  await flush(config);
  await processPushes(config);
  for (const clone of config.clones) {
    try {
      const current = readRepositoryState(clone.path);
      if (clone.headSha && clone.branch) {
        const observation = observeRepositoryState({branch: clone.branch, headSha: clone.headSha, remoteHeadSha: clone.remoteHeadSha}, current);
        if (observation.event) {
          const queue = loadQueue();
          queue.push({eventKey: eventKey(['pull', clone.repositoryId, current.headSha]), repositoryId: clone.repositoryId, type: 'pull', occurredAt: new Date().toISOString(), data: current, attempts: 0, nextAttempt: 0});
          saveQueue(queue, config);
        }
      }
      Object.assign(clone, current);
      let index = git(clone.path, ['rev-parse', '--git-path', 'index']);
      index = path.isAbsolute(index) ? index : path.join(clone.path, index);
      const mtime = fs.statSync(index).mtimeMs;
      const state = indexState.get(clone.path) || {mtime};
      if (mtime !== state.mtime) {
        state.mtime = mtime;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          const data = stagedData(clone.path);
          if (!data.filesChanged) return;
          const queue = loadQueue();
          queue.push({eventKey: eventKey(['stage', clone.repositoryId, mtime, data]), repositoryId: clone.repositoryId, type: 'stage', occurredAt: new Date().toISOString(), data, attempts: 0, nextAttempt: 0});
          saveQueue(queue, config);
        }, 1200);
      }
      indexState.set(clone.path, state);
    } catch {}
  }
  saveConfig(config, {preserveCurrentScalars: true});
}

export function startHeartbeatLoop(
  send: () => Promise<unknown>,
  intervalMs = 15_000,
  onError: (error: unknown) => void = error => console.error(new Date().toISOString(), String(error)),
) {
  let sending = false;
  const timer = setInterval(() => {
    if (sending) return;
    sending = true;
    void send().catch(onError).finally(() => { sending = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function runAgent(config: Config, once = false) {
  const states = new Map<string, {mtime: number; timer?: NodeJS.Timeout}>();
  const stopHeartbeat = once
    ? undefined
    : startHeartbeatLoop(() => api(loadConfig(), '/api/agents/heartbeat', {method: 'POST'}));
  try {
    do {
      // Pick up roots/clones written by interactive CLI commands while this
      // long-running process is alive instead of retaining its startup snapshot.
      config = loadConfig();
      try { await tick(config, states); } catch (error) { console.error(new Date().toISOString(), String(error)); }
      if (once) return;
      await new Promise(resolve => setTimeout(resolve, config.pollMs));
    } while (true);
  } finally {
    stopHeartbeat?.();
  }
}
