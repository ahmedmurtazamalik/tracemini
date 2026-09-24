#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const sessionPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tracemini-codex', 'session.json');
const protocolVersion = '2025-06-18';
const number = {type: 'integer', minimum: 1};
const date = {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'};
const tools = [
  {name: 'tracemini_workspaces', description: 'List workspaces available to the signed-in TraceMini account.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'tracemini_dashboard', description: 'Read workspace Git activity, repositories, commit statistics, and a team timeline for up to 90 days.', inputSchema: {type: 'object', properties: {workspaceId: number, from: date, to: date, timezone: {type: 'string'}, userId: number, repositoryId: number}, required: ['workspaceId'], additionalProperties: false}},
  {name: 'tracemini_timeline', description: 'Read team activity buckets for a workspace and date range of up to 90 days.', inputSchema: {type: 'object', properties: {workspaceId: number, from: date, to: date, timezone: {type: 'string'}, userId: number, repositoryId: number}, required: ['workspaceId'], additionalProperties: false}},
  {name: 'tracemini_reports', description: 'List existing reports in a workspace.', inputSchema: {type: 'object', properties: {workspaceId: number}, required: ['workspaceId'], additionalProperties: false}},
  {name: 'tracemini_report', description: 'Read one existing report by its ID.', inputSchema: {type: 'object', properties: {reportId: number}, required: ['reportId'], additionalProperties: false}},
];

function positiveId(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function range(args) {
  if (Boolean(args.from) !== Boolean(args.to)) throw new Error('from and to must be supplied together');
  if (!args.from) return;
  for (const key of ['from', 'to']) {
    if (typeof args[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[key]) || Number.isNaN(Date.parse(`${args[key]}T00:00:00Z`))) throw new Error(`${key} must be a valid YYYY-MM-DD date`);
  }
  const days = (Date.parse(`${args.to}T00:00:00Z`) - Date.parse(`${args.from}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days >= 90) throw new Error('date range must be 90 days or fewer');
}
function urlFor(base, endpoint, params = {}) {
  const url = new URL(endpoint, `${base.replace(/\/$/, '')}/`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url;
}
async function session() {
  let raw;
  try { raw = await fs.readFile(sessionPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('TraceMini sign-in needed. Run the login command documented in the TraceMini plugin README in your terminal.');
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed.token !== 'string' || !parsed.token || typeof parsed.server !== 'string') throw new Error('Invalid TraceMini session; sign in again.');
  const server = new URL(parsed.server);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(server.hostname))) throw new Error('TraceMini server must use HTTPS (or local HTTP).');
  return parsed;
}
async function get(endpoint, params) {
  const {server, token} = await session();
  const response = await fetch(urlFor(server, endpoint, params), {headers: {authorization: `Bearer ${token}`, accept: 'application/json'}, signal: AbortSignal.timeout(15000)});
  if (response.status === 401) throw new Error('TraceMini session expired. Run the local login command again.');
  if (!response.ok) throw new Error(`TraceMini API returned HTTP ${response.status}`);
  return response.json();
}
async function call(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  if (name === 'tracemini_workspaces') return get('/api/workspaces');
  if (name === 'tracemini_report') {
    const report = await get(`/api/reports/${positiveId(args.reportId, 'reportId')}`);
    if (typeof report.markdown === 'string' && report.markdown.length > 40000) return {...report, markdown: report.markdown.slice(0, 40000), truncated: true};
    return report;
  }
  const workspaceId = positiveId(args.workspaceId, 'workspaceId');
  if (name === 'tracemini_reports') return (await get(`/api/workspaces/${workspaceId}/reports`)).slice(0, 100);
  if (name === 'tracemini_dashboard' || name === 'tracemini_timeline') {
    range(args);
    const params = {};
    for (const key of ['from', 'to', 'timezone']) if (args[key] !== undefined) {
      if (typeof args[key] !== 'string' || args[key].length > 100) throw new Error(`${key} must be a short string`);
      params[key] = args[key];
    }
    for (const key of ['userId', 'repositoryId']) if (args[key] !== undefined) params[key] = positiveId(args[key], key);
    if (name === 'tracemini_timeline') return get(`/api/workspaces/${workspaceId}/timeline`, params);
    const dashboard = await get(`/api/workspaces/${workspaceId}/dashboard`, params);
    return {...dashboard, events: Array.isArray(dashboard.events) ? dashboard.events.slice(0, 100) : dashboard.events, eventsTruncated: Array.isArray(dashboard.events) && dashboard.events.length > 100};
  }
  throw new Error(`Unknown tool: ${name}`);
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return;
  const id = message.id;
  try {
    if (message.method === 'initialize') return send({jsonrpc: '2.0', id, result: {protocolVersion, capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'tracemini', version: '0.2.0'}}});
    if (message.method === 'ping') return send({jsonrpc: '2.0', id, result: {}});
    if (message.method === 'tools/list') return send({jsonrpc: '2.0', id, result: {tools}});
    if (message.method === 'tools/call') {
      try {
        const result = await call(message.params?.name, message.params?.arguments);
        return send({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: JSON.stringify(result)}]}});
      } catch (error) {
        return send({jsonrpc: '2.0', id, result: {isError: true, content: [{type: 'text', text: error.message || 'TraceMini request failed'}]}});
      }
    }
    return send({jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}});
  } catch (error) { send({jsonrpc: '2.0', id, error: {code: -32603, message: error.message || 'Internal error'}}); }
}
const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
lines.on('line', line => { try { void handle(JSON.parse(line)); } catch { /* malformed input */ } });
