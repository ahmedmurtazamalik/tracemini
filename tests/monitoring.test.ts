import {afterEach, expect, it, vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import {registerMonitoring} from '../apps/server/src/monitoring.js';
import type {DB} from '../apps/server/src/db.js';

afterEach(() => vi.unstubAllEnvs());
it('fails closed and exposes only scoped delivery aggregates, not report contents', async () => {
  const query = vi.fn(async (sql: string) => ({rows: sql.startsWith('SELECT') ? [{count_24h: '2', count_48h: '3',
    last_success_at: '2026-11-10T01:00:00Z', failed: '1', overdue: '0', markdown: 'PRIVATE', name: 'PRIVATE'}] : []}));
  const db = {query, transaction: async (fn: () => unknown) => fn()} as unknown as DB;
  const app = express(); registerMonitoring(app, db);
  await request(app).get('/api/monitoring/workflow').expect(503);
  vi.stubEnv('NEXUS_MONITOR_TOKEN', 'monitor-secret-'.repeat(4));
  vi.stubEnv('NEXUS_MONITOR_WORKSPACE_ID', '22');
  await request(app).get('/api/monitoring/workflow').expect(401);
  await request(app).get('/api/monitoring/workflow').set('Authorization', 'Bearer wrong').expect(401);
  expect(query).not.toHaveBeenCalled();
  const result = await request(app).get('/api/monitoring/workflow?workspaceId=999')
    .set('Authorization', `Bearer ${process.env.NEXUS_MONITOR_TOKEN}`).expect(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.body).toEqual({version: 1, key: 'slack-reports', available: true, checkedAt: expect.any(String),
    count24h: 2, count48h: 3, lastSuccessAt: '2026-11-10T01:00:00.000Z', failed: 1, overdue: 0});
  const [sql, params] = query.mock.calls.at(-1)!;
  expect(sql).toContain('FROM reports WHERE workspace_id=$1');
  expect(sql).toContain("slack_status='sent'");
  expect(params[0]).toBe(22);
  query.mockRejectedValueOnce(new Error('PRIVATE database detail'));
  const failed = await request(app).get('/api/monitoring/workflow').set('Authorization', `Bearer ${process.env.NEXUS_MONITOR_TOKEN}`).expect(503);
  expect(JSON.stringify(failed.body)).not.toContain('PRIVATE');
});
