#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {execFileSync} from 'node:child_process';

const sessionPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tracemini-codex', 'session.json');
const args = process.argv.slice(2);
if (args.includes('--logout')) {
  await fs.rm(sessionPath, {force: true});
  process.stdout.write('TraceMini session removed.\n');
  process.exit(0);
}
const index = args.indexOf('--server');
const server = index >= 0 ? args[index + 1] : 'https://tracemini.vercel.app';
if (!server || args.some((arg, i) => arg !== '--server' && i !== index + 1)) throw new Error('Usage: node login.mjs [--server https://host] [--logout]');
const url = new URL(server);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS, except for a local server.');
if (url.username || url.password || url.search || url.hash) throw new Error('Server URL must contain only the origin.');
const input = await fs.open('/dev/tty', 'r');
const output = await fs.open('/dev/tty', 'w');
const prompt = async (label, hidden = false) => {
  await output.write(label);
  if (hidden) execFileSync('stty', ['-echo'], {stdio: [input.fd, 'ignore', 'ignore']});
  try {
    let value = '';
    const bytes = Buffer.alloc(1);
    while (true) {
      const {bytesRead} = await input.read(bytes, 0, 1, null);
      if (!bytesRead || bytes[0] === 10) break;
      if (bytes[0] !== 13) value += bytes.toString('utf8', 0, bytesRead);
    }
    return value;
  } finally {
    if (hidden) { execFileSync('stty', ['echo'], {stdio: [input.fd, 'ignore', 'ignore']}); await output.write('\n'); }
  }
};
try {
  const email = await prompt('TraceMini email: ');
  const password = await prompt('TraceMini password: ', true);
  const response = await fetch(new URL('/api/auth/login', url), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email, password}), signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Sign-in failed (HTTP ${response.status}).`);
  const data = await response.json();
  if (typeof data.token !== 'string' || !data.token) throw new Error('Server did not return a session token.');
  await fs.mkdir(path.dirname(sessionPath), {recursive: true, mode: 0o700});
  await fs.writeFile(sessionPath, JSON.stringify({server: url.origin, token: data.token}), {mode: 0o600});
  await fs.chmod(sessionPath, 0o600);
  process.stdout.write('Signed in to TraceMini.\n');
} finally { await input.close(); await output.close(); }
