import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {sendSlackReport, slackReportSummary} from '../apps/server/src/slack.js';

afterEach(() => vi.unstubAllGlobals());

describe('Slack report notifications', () => {
  it('loads the root local environment for both server commands', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../apps/server/package.json'), 'utf8'));
    expect(packageJson.scripts.dev).toContain('--env-file-if-exists=../../.env.local');
    expect(packageJson.scripts.start).toContain('--env-file-if-exists=../../.env.local');
  });

  it('extracts at most two clean summary lines from report Markdown', () => {
    expect(slackReportSummary('# Delivery report\n\n```ts\nconst secret = "not for Slack";\n```\n- **Shipped** the report scheduler.\n- Fixed [workspace access](https://example.test).\n- This third detail stays in the report.')).toBe('Shipped the report scheduler.\nFixed workspace access.');
  });

  it('sends a short summary with the TraceMini link last', async () => {
    const post = vi.fn().mockResolvedValue({ok: true});
    vi.stubGlobal('fetch', post);

    await sendSlackReport('https://hooks.slack.test/report', {
      id: 42,
      workspaceId: 7,
      name: 'Weekly delivery',
      startDate: '2026-08-18',
      endDate: '2026-08-24',
      scope: 'workspace',
      summary: 'Shipped scheduled reports.\nImproved workspace access checks.',
    }, 'https://trace.example');

    const [url, request] = post.mock.calls[0];
    expect(url).toBe('https://hooks.slack.test/report');
    expect(JSON.parse(request.body)).toEqual({text: 'Workspace report ready: Weekly delivery\n2026-08-18 to 2026-08-24\n\nShipped scheduled reports.\nImproved workspace access checks.\n\nhttps://trace.example/workspaces/7/reports/42'});
    expect(request.body.endsWith('reports/42"}')).toBe(true);
  });
});
