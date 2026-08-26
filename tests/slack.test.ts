import {afterEach, describe, expect, it, vi} from 'vitest';
import {sendSlackReport} from '../apps/server/src/slack.js';

afterEach(() => vi.unstubAllGlobals());

describe('Slack report notifications', () => {
  it('sends report metadata and a TraceMini link without report content', async () => {
    const post = vi.fn().mockResolvedValue({ok: true});
    vi.stubGlobal('fetch', post);

    await sendSlackReport('https://hooks.slack.test/report', {
      id: 42,
      workspaceId: 7,
      name: 'Weekly delivery',
      startDate: '2026-08-18',
      endDate: '2026-08-24',
      scope: 'workspace',
    }, 'https://trace.example');

    const [url, request] = post.mock.calls[0];
    expect(url).toBe('https://hooks.slack.test/report');
    expect(JSON.parse(request.body)).toEqual({text: 'Workspace report ready: Weekly delivery\n2026-08-18 to 2026-08-24\nhttps://trace.example/workspaces/7/reports/42'});
    expect(request.body).not.toContain('markdown');
  });
});
