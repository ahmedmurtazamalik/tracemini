#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {api} from './api.js';
import {loadConfig, saveConfig, loadQueue, saveQueue, eventKey} from './config.js';
import {commitData, git, parsePrePush, removeHooks, stagedData} from './git.js';
import {flush, registerWatchedRoots, runAgent, syncHistory} from './agent.js';
import {installStartup, restartStartup, stopStartup} from './install.js';
import {normalizeServerUrl, previousDeviceTokenForServer} from './pairing.js';

const args = process.argv.slice(2);
const command = args.shift();
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const config = loadConfig();

function bindWorkspace(workspaceId?: number, forceReset = false) {
  const changed = forceReset || config.workspaceId !== workspaceId;
  if (changed) {
    config.watchedPaths = [];
    config.clones = [];
  }
  if (workspaceId) config.workspaceId = workspaceId;
  else delete config.workspaceId;
  saveConfig(config, {
    replaceRepositoryState: changed,
    beforeRepositoryStateReplace: changed
      ? current => { for (const clone of current.clones) { try { removeHooks(clone.path); } catch {} } }
      : undefined,
  });
  if (changed) {
    saveQueue([], config);
  }
}

async function exchangeInstallToken() {
  const requestedServer = flag('--server');
  const installToken = flag('--install-token');
  if (!requestedServer || !installToken) throw new Error('install requires its generated --server and --install-token arguments');
  const server = normalizeServerUrl(requestedServer);
  const previousAgentToken = previousDeviceTokenForServer(config, server);
  const exchangeConfig = {...config, serverUrl: server, agentToken: previousAgentToken, userToken: undefined};
  const response = await api<any>(exchangeConfig, '/api/agents/install/exchange', {method: 'POST', body: JSON.stringify({installToken, machineName: flag('--machine') || os.hostname()})});
  config.serverUrl = server;
  config.agentToken = response.agentToken;
  config.agentId = response.agentId;
  delete config.userToken;
  bindWorkspace(response.workspaceId, true);
  return response;
}

async function main() {
  if (command === 'install') {
    stopStartup();
    const response = await exchangeInstallToken();
    const startup = installStartup();
    console.log(`Device ${response.agentId} installed and started via ${startup}`);
    return;
  }
  if (command === 'sync') {
    stopStartup();
    const response = await exchangeInstallToken();
    restartStartup();
    console.log(`Device ${response.agentId} synced to workspace ${response.workspaceId}`);
    return;
  }
  if (command === 'login') {
    const server = flag('--server');
    if (server) config.serverUrl = server;
    const bearer = flag('--token');
    if (!bearer) throw new Error('login requires --token; browser onboarding should use the generated install command instead');
    config.userToken = bearer;
    const agent = await api<any>(config, '/api/agents/register', {method: 'POST', body: JSON.stringify({machineName: flag('--machine') || os.hostname()})}, false);
    config.agentToken = agent.token;
    config.agentId = agent.agentId;
    bindWorkspace(undefined, true);
    console.log(`Device ${agent.agentId} registered`);
    return;
  }
  if (command === 'join') {
    if (!args[0]) throw new Error('join requires invite code');
    const workspace = await api<any>(config, '/api/workspaces/join', {method: 'POST', body: JSON.stringify({inviteCode: args[0]})}, false);
    await api(config, '/api/agents/workspace', {method: 'POST', body: JSON.stringify({workspaceId: String(workspace.id)})});
    bindWorkspace(workspace.id);
    console.log(`Joined ${workspace.name} (${workspace.id})`);
    return;
  }
  if (command === 'use-workspace') {
    const workspaceId = Number(args[0]);
    if (!workspaceId) throw new Error('use-workspace requires a workspace id');
    await api(config, '/api/agents/workspace', {method: 'POST', body: JSON.stringify({workspaceId: String(workspaceId)})});
    bindWorkspace(workspaceId);
    console.log(`Workspace ${config.workspaceId} selected`);
    return;
  }
  if (command === 'watch') {
    if (!config.workspaceId) throw new Error('install or select a workspace first');
    if (!args[0]) throw new Error('watch requires a repository root path');
    const root = path.resolve(args[0]);
    if (!config.watchedPaths.includes(root)) config.watchedPaths.push(root);
    const found = await registerWatchedRoots(config);
    console.log(`Registered ${found} repository clone(s). Run tracemini sync-history to import existing commits.`);
    return;
  }
  if (command === 'sync-history') {
    if (!config.workspaceId) throw new Error('install or select a workspace first');
    const days = Number(flag('--days') || 90);
    if (!Number.isFinite(days) || days < 1) throw new Error('sync-history --days must be a positive number');
    const result = await syncHistory(config, days);
    console.log(`History synchronized: ${result.commits} commit(s) across ${result.repositories} repository clone(s)`);
    return;
  }
  if (command === 'repositories') { console.table(config.clones); return; }
  if (command === 'status') {
    const status = await api<any>(config, '/api/agents/status');
    console.log(JSON.stringify({...status, server: config.serverUrl, workspaceId: config.workspaceId, watchedPaths: config.watchedPaths, clones: config.clones.length, queued: loadQueue().length}, null, 2));
    return;
  }
  if (command === 'event') {
    const repoPath = path.resolve(flag('--repo') || process.cwd());
    const type = flag('--type') || args[0];
    const clone = config.clones.find(item => item.path === repoPath);
    if (!clone) throw new Error(`repository is not registered: ${repoPath}`);
    if (type === 'push' && flag('--hook') === 'pre-push') {
      const stdin = fs.readFileSync(0, 'utf8');
      for (const intent of parsePrePush(args.at(-2) || '', args.at(-1) || '', stdin)) {
        const occurredAt = new Date().toISOString();
        await api(config, '/api/pushes/pending', {method: 'POST', body: JSON.stringify({...intent, repositoryId: clone.repositoryId, occurredAt, eventKey: eventKey(['push', clone.repositoryId, intent.ref, intent.expectedSha, occurredAt])})});
      }
      return;
    }
    let data: any = {branch: git(repoPath, ['branch', '--show-current']) || '(detached)', hook: flag('--hook')};
    if (type === 'commit') data = commitData(repoPath);
    else if (type === 'stage') data = stagedData(repoPath);
    else if (type === 'branch') data = {...data, oldCommit: args.at(-3), newCommit: args.at(-2), branchCheckout: args.at(-1)};
    else if (type === 'merge' || type === 'pull') data = {...data, commitSha: git(repoPath, ['rev-parse', 'HEAD'])};
    else if (type === 'push') data = {...data, confirmation: 'unconfirmed', reason: 'explicit event has no remote verification target'};
    const occurredAt = new Date().toISOString();
    const queue = loadQueue();
    queue.push({eventKey: eventKey([type, clone.repositoryId, data.commitSha || '', data.oldCommit || '', data.newCommit || '', occurredAt.slice(0, 16), data]), repositoryId: clone.repositoryId, type, occurredAt, data, attempts: 0, nextAttempt: 0});
    saveQueue(queue, config);
    await flush(config);
    return;
  }
  if (command === 'start' || command === 'once') { await runAgent(config, command === 'once'); return; }
  console.log('Usage: tracemini sync --server URL --install-token TOKEN | watch PATH | sync-history [--days 90] | repositories | status | event --repo PATH --type TYPE | start | once');
}

main().catch(error => {
  console.error(`TraceMini: ${error.message || error}`);
  process.exitCode = 1;
});
