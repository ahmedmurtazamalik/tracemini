#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {api} from './api.js';
import {enqueue, loadConfig, saveConfig, loadQueue, saveQueue, eventKey} from './config.js';
import {commitData, git, parsePrePush, removeHooks, repositoryFingerprint, stagedData} from './git.js';
import {flush, runAgent, scanWatchedRoots} from './agent.js';
import {installStartup, restartStartup, stopStartup} from './install.js';
import {normalizeServerUrl, previousDeviceTokenForServer, rebindDeviceConfig, rebindWorkspaceConfig} from './pairing.js';

const args = process.argv.slice(2);
const command = args.shift();
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const config = loadConfig();

function bindWorkspace(workspaceId?: number, forceReset = false) {
  const changed = forceReset || config.workspaceId !== workspaceId;
  Object.assign(config, rebindWorkspaceConfig(config, workspaceId, forceReset));
  saveConfig(config, {
    replaceRepositoryState: changed,
    beforeRepositoryStateReplace: changed
      ? current => { for (const clone of current.clones) { try { removeHooks(clone.path); } catch {} } }
      : undefined,
  });
  if (changed) saveQueue([], config);
}

async function exchangeInstallToken() {
  const requestedServer = flag('--server');
  const installToken = flag('--install-token');
  if (!requestedServer || !installToken) throw new Error('install requires its generated --server and --install-token arguments');
  const server = normalizeServerUrl(requestedServer);
  const previousAgentToken = previousDeviceTokenForServer(config, server);
  const exchangeConfig = {...config, serverUrl: server, agentToken: previousAgentToken, userToken: undefined};
  const response = await api<any>(exchangeConfig, '/api/agents/install/exchange', {method: 'POST', body: JSON.stringify({installToken, machineName: flag('--machine') || os.hostname()})});
  const rebound = rebindDeviceConfig(config, server, response);
  Object.assign(config, rebound);
  delete config.userToken;
  saveConfig(rebound, {
    replaceCollections: true,
    beforeRepositoryStateReplace: current => { for (const clone of current.clones) { try { removeHooks(clone.path); } catch {} } },
  });
  saveQueue([], rebound);
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
    const found = await scanWatchedRoots(config, [root]);
    console.log(`Scanned watched roots; ${found} repository candidate(s) discovered. Select tracing in TraceMini Settings.`);
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
    const identityFingerprint = repositoryFingerprint(repoPath);
    if (!clone.repositoryFingerprint || clone.repositoryFingerprint !== identityFingerprint) throw new Error(`repository identity changed: ${repoPath}`);
    if (type === 'push' && flag('--hook') === 'pre-push') {
      const stdin = fs.readFileSync(0, 'utf8');
      for (const intent of parsePrePush(args.at(-2) || '', args.at(-1) || '', stdin)) {
        if (repositoryFingerprint(repoPath) !== identityFingerprint) throw new Error(`repository identity changed: ${repoPath}`);
        const occurredAt = new Date().toISOString();
        await api(config, '/api/pushes/pending', {method: 'POST', body: JSON.stringify({...intent, repositoryId: clone.repositoryId, localKey: clone.path, identityFingerprint, occurredAt, eventKey: eventKey(['push', clone.repositoryId, intent.ref, intent.expectedSha, occurredAt])})});
      }
      return;
    }
    let data: any = {branch: git(repoPath, ['branch', '--show-current']) || '(detached)', hook: flag('--hook')};
    if (type === 'commit') data = commitData(repoPath);
    else if (type === 'stage') data = stagedData(repoPath);
    else if (type === 'branch') data = {...data, oldCommit: args.at(-3), newCommit: args.at(-2), branchCheckout: args.at(-1)};
    else if (type === 'merge' || type === 'pull') data = {...data, commitSha: git(repoPath, ['rev-parse', 'HEAD'])};
    else if (type === 'push') data = {...data, confirmation: 'unconfirmed', reason: 'explicit event has no remote verification target'};
    if (repositoryFingerprint(repoPath) !== identityFingerprint) throw new Error(`repository identity changed: ${repoPath}`);
    const occurredAt = new Date().toISOString();
    enqueue({eventKey: eventKey([type, clone.repositoryId, data.commitSha || '', data.oldCommit || '', data.newCommit || '', occurredAt.slice(0, 16), data]), repositoryId: clone.repositoryId, localKey: clone.path, identityFingerprint, type, occurredAt, data, attempts: 0, nextAttempt: 0});
    await flush(config);
    return;
  }
  if (command === 'start' || command === 'once') { await runAgent(config, command === 'once'); return; }
  console.log('Usage: tracemini sync --server URL --install-token TOKEN | watch PATH | repositories | status | event --repo PATH --type TYPE | start | once');
}

main().catch(error => {
  console.error(`TraceMini: ${error.message || error}`);
  process.exitCode = 1;
});
