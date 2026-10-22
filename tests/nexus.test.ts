import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {processJob} from '../packages/cli/src/agent.js';
import {type Config} from '../packages/cli/src/config.js';
import {markdownToPlainText, sendScheduledNexusReport} from '../packages/cli/src/nexus.js';
import {CodexRunner} from '../packages/cli/src/runner.js';

const config: Config = {
  serverUrl: 'https://tracemini.test', agentToken: 'agent-token', workspaceId: 7,
  watchedPaths: [], clones: [], reporter: 'codex', pollMs: 60_000,
};
const scheduledJob = {
  id: 42, workspace_id: 7, scheduled_for: '2026-10-06T00:00:00.000Z',
  start_date: '2026-10-05', end_date: '2026-10-05', reporter: 'codex',
};
const markdown = '# Daily report\n\n## Murtaza\n\n- **Shipped** `order_id` support.';
let temporary: string;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-nexus-'));
  vi.stubEnv('TRACEMINI_HOME', temporary);
  vi.stubEnv('NEXUS_CHAT_TOKEN', 'nexus-test-token');
  vi.stubEnv('NEXUS_CHAT_CONVERSATION_ID', '25');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, {recursive: true, force: true});
});

describe('scheduled Nexus report delivery', () => {
  it('renders report formatting as readable plain text without changing identifiers or code', () => {
    const text = markdownToPlainText([
      '# Daily report', '', '## Murtaza', '',
      '- **Shipped** `order_id` in repo_name; *reviewed* _carefully_.',
      '- [x] Tested [report download](https://example.test/reports).',
      '- [ ] Follow up on ~~old wording~~.',
      '> According to work-notes.md, Ali completed the review.', '',
      '```ts', 'const report_name = "**literal**";', '```',
    ].join('\n'));

    expect(text).toContain('Daily report');
    expect(text).toContain('Murtaza');
    expect(text).toContain('Shipped order_id in repo_name; reviewed carefully.');
    expect(text).toContain('report download');
    expect(text).toContain('https://example.test/reports');
    expect(text).toContain('Follow up on old wording.');
    expect(text).toContain('According to work-notes.md, Ali completed the review.');
    expect(text).toContain('const report_name = "**literal**";');
    expect(text).not.toMatch(/^\s*(?:#{1,6}\s|>\s|[-*+]\s\[[ xX]\])/m);
    expect(text).not.toContain('```');
    expect(text).not.toContain('[report download]');
  });

  it('reads the local credential file without adding its values to the process environment', async () => {
    vi.stubEnv('NEXUS_CHAT_TOKEN', undefined);
    vi.stubEnv('NEXUS_CHAT_CONVERSATION_ID', undefined);
    fs.writeFileSync(path.join(temporary, 'nexus.env'), 'NEXUS_CHAT_TOKEN="local-test-token"\nNEXUS_CHAT_CONVERSATION_ID=25\n', {mode: 0o600});
    const post = vi.fn().mockResolvedValue(Response.json({ok: true, message: {id: '92'}}));
    vi.stubGlobal('fetch', post);

    expect(await sendScheduledNexusReport(config, scheduledJob, markdown)).toBe(true);

    const [url, init] = post.mock.calls[0];
    expect(url).toBe('https://nexus.neodym.ai/api/chat/v1/conversations/25/messages');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer local-test-token');
    expect(JSON.parse(init.body)).toEqual({body: markdownToPlainText(markdown)});
    expect(process.env.NEXUS_CHAT_TOKEN).toBeUndefined();
    expect(process.env.NEXUS_CHAT_CONVERSATION_ID).toBeUndefined();
  });

  it('skips unconfigured devices and manual reports', async () => {
    const post = vi.fn();
    vi.stubGlobal('fetch', post);
    expect(await sendScheduledNexusReport(config, {id: 43}, markdown)).toBe(false);
    vi.stubEnv('NEXUS_CHAT_TOKEN', undefined);
    vi.stubEnv('NEXUS_CHAT_CONVERSATION_ID', undefined);
    expect(await sendScheduledNexusReport(config, scheduledJob, markdown)).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('delivers the entire long report in bounded parts with stable keys for transient retries', async () => {
    const lines = Array.from({length: 130}, (_, index) => `Contribution ${String(index).padStart(3, '0')}: Delivered the requested report behavior and verified it.`);
    const post = vi.fn()
      .mockResolvedValueOnce(Response.json({error: 'unavailable'}, {status: 503}))
      .mockImplementation(async () => Response.json({ok: true, message: {id: '92'}}));
    vi.stubGlobal('fetch', post);

    await sendScheduledNexusReport(config, scheduledJob, lines.join('\n'));

    const firstRequests = post.mock.calls.map(([, init]) => init);
    const key = (init: RequestInit) => new Headers(init.headers).get('idempotency-key');
    expect(key(firstRequests[0])).toBeTruthy();
    expect(key(firstRequests[0])).toBe(key(firstRequests[1]));
    expect(firstRequests[0].body).toBe(firstRequests[1].body);
    const delivered = firstRequests.slice(1);
    expect(delivered.length).toBeGreaterThan(1);
    expect(new Set(delivered.map(key)).size).toBe(delivered.length);
    const bodies = delivered.map(init => JSON.parse(String(init.body)).body as string);
    expect(bodies.every(body => body.length <= 3500)).toBe(true);
    for (const line of lines) expect(bodies.join('\n').split(line)).toHaveLength(2);

    post.mockClear();
    await sendScheduledNexusReport(config, scheduledJob, lines.join('\n'));
    expect(post.mock.calls.map(([, init]) => key(init))).toEqual(delivered.map(key));
    post.mockClear();
    await sendScheduledNexusReport(config, {...scheduledJob, id: 43}, markdown);
    expect(key(post.mock.calls[0][1])).not.toBe(key(delivered[0]));
  });

  it.each([true, false])('saves a generated report before delivery and only forwards scheduled jobs (scheduled=%s)', async scheduled => {
    const job = {...scheduledJob, scheduled_for: scheduled ? scheduledJob.scheduled_for : null};
    vi.spyOn(CodexRunner.prototype, 'generate').mockResolvedValue(markdown);
    const calls: Array<{url: string; init: RequestInit}> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({url, init});
      return Response.json(url.endsWith('/context') ? {job, events: []} : {ok: true, message: {id: '92'}});
    }));

    await processJob(config, job);

    const completed = calls.findIndex(call => call.url.endsWith('/complete'));
    const sent = calls.findIndex(call => call.url.startsWith('https://nexus.neodym.ai/'));
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(String(calls[completed].init.body))).toEqual({markdown});
    if (scheduled) {
      expect(sent).toBeGreaterThan(completed);
      expect(JSON.parse(String(calls[sent].init.body))).toEqual({body: markdownToPlainText(markdown)});
    } else expect(sent).toBe(-1);
    expect(calls.some(call => call.url.endsWith('/fail'))).toBe(false);
  });

  it('does not retry a Nexus rejection or fail a report already saved to TraceMini', async () => {
    vi.spyOn(CodexRunner.prototype, 'generate').mockResolvedValue(markdown);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('https://nexus.neodym.ai/')) return Response.json({error: 'nexus-test-token'}, {status: 403});
      return Response.json(url.endsWith('/context') ? {job: scheduledJob, events: []} : {ok: true});
    }));

    await expect(processJob(config, scheduledJob)).resolves.toBeUndefined();

    expect(urls.filter(url => url.startsWith('https://nexus.neodym.ai/'))).toHaveLength(1);
    expect(urls.some(url => url.endsWith('/fail'))).toBe(false);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().map(String).join(' ')).not.toContain('nexus-test-token');
  });

  it('does not publish a report whose persistence failed', async () => {
    vi.spyOn(CodexRunner.prototype, 'generate').mockResolvedValue(markdown);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/complete')) return Response.json({error: 'save failed'}, {status: 500});
      return Response.json(url.endsWith('/context') ? {job: scheduledJob, events: []} : {ok: true});
    }));

    await expect(processJob(config, scheduledJob)).rejects.toThrow('save failed');

    expect(urls.filter(url => url.endsWith('/fail'))).toHaveLength(1);
    expect(urls.some(url => url.startsWith('https://nexus.neodym.ai/'))).toBe(false);
  });
});
