#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {api} from './api.js';
import {loadConfig, saveConfig, loadQueue, saveQueue, eventKey} from './config.js';
import {commitData, git, parsePrePush, stagedData} from './git.js';
import {flush, runAgent, scanWatchedRoots} from './agent.js';
import {installStartup} from './install.js';

const args = process.argv.slice(2);
const command = args.shift();
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const config = loadConfig();

async function exchangeInstallToken() {
  const server = flag('--server');
  const installToken = flag('--install-token');
  if (!server || !installToken) throw new Error('install requires its generated --server and --install-token arguments');
  config.serverUrl = server;
  const response = await api<any>(config, '/api/agents/install/exchange', {method: 'POST', body: JSON.stringify({installToken, machineName: flag('--machine') || os.hostname()})}, false);
  config.agentToken = response.agentToken;
  config.agentId = response.agentId;
  config.workspaceId = response.workspaceId;
  delete config.userToken;
  saveConfig(config);
  return response;
}

async function main() {
  if (command === 'install') {
    const response = await exchangeInstallToken();
    const startup = installStartup();
    console.log(`Agent ${response.agentId} installed and started via ${startup}`);
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
    saveConfig(config);
    console.log(`Agent ${agent.agentId} registered`);
    return;
  }
  if (command === 'join') {
    if (!args[0]) throw new Error('join requires invite code');
    const workspace = await api<any>(config, '/api/workspaces/join', {method: 'POST', body: JSON.stringify({inviteCode: args[0]})}, false);
    await api(config, '/api/agents/workspace', {method: 'POST', body: JSON.stringify({workspaceId: String(workspace.id)})});
    config.workspaceId = workspace.id;
    saveConfig(config);
    console.log(`Joined ${workspace.name} (${workspace.id})`);
    return;
  }
  if (command === 'use-workspace') {
    const workspaceId = Number(args[0]);
    if (!workspaceId) throw new Error('use-workspace requires a workspace id');
    await api(config, '/api/agents/workspace', {method: 'POST', body: JSON.stringify({workspaceId: String(workspaceId)})});
    config.workspaceId = workspaceId;
    saveConfig(config);
    console.log(`Workspace ${config.workspaceId} selected`);
    return;
  }
  if (command === 'watch') {
    if (!config.workspaceId) throw new Error('install or select a workspace first');
    const root = path.resolve(args[0] || '');
    if (!config.watchedPaths.includes(root)) config.watchedPaths.push(root);
    const found = await scanWatchedRoots(config);
    console.log(`Scanned watched roots; ${found} repository clone(s) registered`);
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
    saveQueue(queue);
    await flush(config);
    return;
  }
  if (command === 'start' || command === 'once') { await runAgent(config, command === 'once'); return; }
  console.log('Usage: tracemini watch PATH | repositories | status | event --repo PATH --type TYPE | start | once');
}

main().catch(error => {
  console.error(`TraceMini: ${error.message || error}`);
  process.exitCode = 1;
});
