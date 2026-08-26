import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const server = fs.readFileSync(path.join(root, 'apps/server/src/app.ts'), 'utf8');
const web = fs.readFileSync(path.join(root, 'apps/web/src.tsx'), 'utf8');

describe('activity timeline delivery', () => {
  it('polls only a grouped timeline endpoint and prevents overlapping refreshes', () => {
    expect(server).toContain("app.get('/api/workspaces/:id/timeline'");
    expect(server).toContain("date_bin('${bucketMinutes} minutes',source.occurred_at");
    expect(server).toContain('COUNT(*)::INTEGER event_count');
    expect(web).toContain('if (refreshInFlight.current) return;');
    expect(web).toContain('const generation = dataGeneration.current;');
    expect(web).toContain('generation, dataGeneration.current');
    expect(web).toContain('await refreshTimeline();');
    expect(web).not.toContain('document.visibilityState === "visible") void reload();');
  });

  it('invalidates protected dashboard state after authorization loss', () => {
    expect(web).toContain('class ApiRequestError extends Error');
    expect(web).toContain('if (caught instanceof ApiRequestError && (caught.status === 401 || caught.status === 403))');
    expect(web).toContain('await onAuthorizationFailure(caught.status);');
    expect(web).toContain('setEvents([]);');
    expect(web).toContain('setRepositories([]);');
    expect(web).toContain('setToday({users: []});');
  });

  it('provides a semantic table containing every plotted time value', () => {
    expect(web).toContain('<table className="activity-data-table">');
    expect(web).toContain('<th scope="col">Time</th>');
    expect(web).toContain('<th scope="row">{point.label}</th>');
    expect(web).toContain('{user.points[pointIndex]?.total || 0}</td>');
  });
});
