import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {stateDir, type Config} from './config.js';

export function markdownToPlainText(markdown: string) {
  let fence = '';
  return markdown.replace(/\r\n/g, '\n').split('\n').map(line => {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
    if (delimiter && (!fence || delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length)) {
      fence = fence ? '' : delimiter[1];
      return '';
    }
    if (fence) return line;
    const code: string[] = [];
    return line
      .replace(/(`+)(.*?)\1/g, (_, _ticks, text) => `\0${code.push(text) - 1}\0`)
      .replace(/^\s{0,3}(?:>\s?)+/, '')
      .replace(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/, '$1')
      .replace(/^\s*(?:[-*_]\s*){3,}$/, '')
      .replace(/^(\s*)[-+*]\s+\[([ xX])\]\s+/, (_, indent, checked) => `${indent}${checked === ' ' ? '☐' : '☑'} `)
      .replace(/^(\s*)[-+*]\s+/, '$1• ')
      .replace(/!?\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => label === url ? url : `${label} (${url})`)
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(/\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__/g, (_, stars, underscores) => stars ?? underscores)
      .replace(/(?<!\w)\*(\S(?:.*?\S)?)\*(?!\w)|(?<!\w)_(\S(?:.*?\S)?)_(?!\w)/g, (_, stars, underscores) => stars ?? underscores)
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/\\([\\`*{}\[\]()#+.!_>~-])/g, '$1')
      .replace(/\0(\d+)\0/g, (_, index) => code[Number(index)]);
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function sendScheduledNexusReport(
  config: Pick<Config, 'serverUrl'>,
  job: {id: number | string; scheduled_for?: string | null},
  markdown: string,
) {
  if (!job.scheduled_for) return false;
  const file = path.join(stateDir(), 'nexus.env');
  const local = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const token = process.env.NEXUS_CHAT_TOKEN || local.NEXUS_CHAT_TOKEN;
  const conversation = process.env.NEXUS_CHAT_CONVERSATION_ID || local.NEXUS_CHAT_CONVERSATION_ID;
  if (!token && !conversation) return false;
  if (!token || !conversation || !/^\d+$/.test(conversation)) throw new Error('Configure NEXUS_CHAT_TOKEN and NEXUS_CHAT_CONVERSATION_ID in the local nexus.env file');

  // Keep messages small, without truncating longer reports or splitting Unicode characters.
  const characters = Array.from(markdownToPlainText(markdown));
  const parts: string[] = [];
  while (characters.length) {
    let end = Math.min(characters.length, 3400);
    if (characters.length > end) {
      const newline = characters.lastIndexOf('\n', end - 1);
      if (newline > end / 2) end = newline + 1;
    }
    parts.push(characters.splice(0, end).join(''));
  }
  for (const [index, part] of parts.entries()) {
    const body = parts.length > 1 ? `Part ${index + 1}/${parts.length}\n\n${part}` : part;
    const key = createHash('sha256').update(`${config.serverUrl.replace(/\/$/, '')}\n${job.id}\n${conversation}\n${index}`).digest('hex');
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(`https://nexus.neodym.ai/api/chat/v1/conversations/${conversation}/messages`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `tracemini-${key}`},
          body: JSON.stringify({body}),
          redirect: 'error',
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        if (!attempt) continue;
        throw new Error('Nexus request failed or timed out');
      }
      if (response.status >= 500 && !attempt) continue;
      if (!response.ok) throw new Error(`Nexus returned HTTP ${response.status}`);
      const result = await response.json().catch(() => null);
      if (result?.ok !== true) throw new Error('Nexus did not acknowledge the message');
      break;
    }
  }
  return parts.length > 0;
}
