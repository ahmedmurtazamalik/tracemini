import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {chunkSlackMrkdwn, markdownToSlackBlocks, sendSlackReport, slackReportRange} from '../apps/server/src/slack.js';

afterEach(() => vi.unstubAllGlobals());

describe('Slack report notifications', () => {
  it('loads the root local environment for both server commands', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../apps/server/package.json'), 'utf8'));
    expect(packageJson.scripts.dev).toContain('--env-file-if-exists=../../.env.local');
    expect(packageJson.scripts.start).toContain('--env-file-if-exists=../../.env.local');
  });

  it('converts report Markdown to Slack mrkdwn', () => {
    const markdown = '# Delivery\n\n**Shipped** [reports](https://example.test/reports).\n\n- First item\n- [x] Complete\n\n| Area | Result |\n| --- | --- |\n| API | Ready |\n\n```ts\nconst value = 1;\n```';
    expect(markdownToSlackBlocks(markdown)).toEqual([{type: 'section', text: {type: 'mrkdwn', text: '*Delivery*\n\n*Shipped* <https://example.test/reports|reports>.\n\n• First item\n☑ Complete\n\n```\n| Area | Result |\n| --- | --- |\n| API | Ready |\n```\n\n```\nconst value = 1;\n```'}}]);
  });

  it('formats a single report date once and a multi-day range twice', () => {
    expect(slackReportRange('2026-08-26', '2026-08-26')).toBe('August 26, 2026');
    expect(slackReportRange('2026-08-20', '2026-08-26')).toBe('August 20, 2026 – August 26, 2026');
  });

  it('keeps long mrkdwn blocks within Slack limits', () => {
    const chunks = chunkSlackMrkdwn(`Intro\n\`\`\`\n${'x'.repeat(6_000)}\n\`\`\``);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 2_900)).toBe(true);
    const blocks = markdownToSlackBlocks(`## Ibrahim\n\n${'Contribution.\n'.repeat(500)}\n## ${'Long title '.repeat(20)}\n\n\`\`\`md\n## Literal code heading\n\`\`\``);
    expect(blocks.filter(block => block.type === 'header')).toEqual([
      {type: 'header', text: {type: 'plain_text', text: '🟡 Ibrahim'}},
    ]);
    expect(blocks.every(block => block.text.text.length <= 2_900)).toBe(true);
    const body = blocks.slice(1).map(block => block.text.text).join('\n');
    expect(body.match(/Contribution\./g)).toHaveLength(500);
    expect(body).toContain('Long title '.repeat(20).trim());
    expect(body).toContain('```\n## Literal code heading\n```');
  });

  it('sends the complete converted report with workspace context and no TraceMini link', async () => {
    const post = vi.fn().mockResolvedValue({ok: true});
    vi.stubGlobal('fetch', post);
    await sendSlackReport('https://hooks.slack.test/report', {
      id: 42, workspaceId: 7, workspaceName: 'Trace Mini', name: 'Daily delivery',
      startDate: '2026-08-26', endDate: '2026-08-26', scope: 'workspace',
      markdown: '# Work completed\n\n## Workspace overview\n\n**Shipped** Slack reports.\n\n## Ibrahim\n\n- Delivered `employee-tracker-cloud`.\n\n## **Murtaza**\n\n### `Visiogen`\n\n- Preserved the entire report.\n\n## Ali\n\n- Reviewed `tracemini`.\n\n## Ashar\n\n- Tested `tracemini`.',
    });

    const [url, request] = post.mock.calls[0];
    const payload = JSON.parse(request.body);
    expect(url).toBe('https://hooks.slack.test/report');
    expect(payload.text).toBe('Daily delivery — Trace Mini — August 26, 2026');
    expect(payload.blocks).toEqual([
      {type: 'header', text: {type: 'plain_text', text: 'Daily delivery'}},
      {type: 'context', elements: [{type: 'mrkdwn', text: '*Workspace:* Trace Mini  •  *Range:* August 26, 2026  •  *Type:* Workspace report'}]},
      {type: 'divider'},
      {type: 'section', text: {type: 'mrkdwn', text: '*Work completed*'}},
      {type: 'header', text: {type: 'plain_text', text: 'Workspace overview'}},
      {type: 'section', text: {type: 'mrkdwn', text: '*Shipped* Slack reports.'}},
      {type: 'header', text: {type: 'plain_text', text: '🟡 Ibrahim'}},
      {type: 'section', text: {type: 'mrkdwn', text: '• Delivered `employee-tracker-cloud`.'}},
      {type: 'header', text: {type: 'plain_text', text: '🟣 Murtaza'}},
      {type: 'section', text: {type: 'mrkdwn', text: '*`Visiogen`*\n\n• Preserved the entire report.'}},
      {type: 'header', text: {type: 'plain_text', text: '🔵 Ali'}},
      {type: 'section', text: {type: 'mrkdwn', text: '• Reviewed `tracemini`.'}},
      {type: 'header', text: {type: 'plain_text', text: '🔴 Ashar'}},
      {type: 'section', text: {type: 'mrkdwn', text: '• Tested `tracemini`.'}},
    ]);
  });
});
