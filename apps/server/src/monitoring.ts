import {createHash, timingSafeEqual} from 'node:crypto';
import type {Express} from 'express';
import type {DB} from './db.js';

// Separate from user/agent access. Only the configured workspace's delivery
// receipts leave the app; generating a report alone is not a Slack success.
export function registerMonitoring(app: Express, db: DB) {
  app.get('/api/monitoring/workflow', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const expected = process.env.NEXUS_MONITOR_TOKEN;
    const workspaceId = Number(process.env.NEXUS_MONITOR_WORKSPACE_ID);
    if (!expected || expected.length < 32 || !Number.isSafeInteger(workspaceId) || workspaceId <= 0)
      return res.status(503).json({error: 'monitoring unavailable'});
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(req.get('authorization') || ''), digest(`Bearer ${expected}`)))
      return res.status(401).json({error: 'unauthorized'});
    const checkedAt = new Date();
    try {
      const row = await db.transaction(async () => {
        await db.query('SET TRANSACTION READ ONLY');
        await db.query("SET LOCAL statement_timeout='5s'");
        return (await db.query(`SELECT
          count(*) FILTER (WHERE slack_status='sent' AND slack_attempted_at >= $2) AS count_24h,
          count(*) FILTER (WHERE slack_status='sent' AND slack_attempted_at >= $3) AS count_48h,
          max(slack_attempted_at) FILTER (WHERE slack_status='sent') AS last_success_at,
          count(*) FILTER (WHERE slack_status='failed' AND slack_attempted_at >= $3) AS failed,
          count(*) FILTER (WHERE slack_status IN ('pending','sending') AND coalesce(slack_attempted_at,created_at) < $4) AS overdue
          FROM reports WHERE workspace_id=$1`, [workspaceId,
          new Date(+checkedAt - 86400000), new Date(+checkedAt - 172800000), new Date(+checkedAt - 1800000)])).rows[0];
      });
      return res.json({version: 1, key: 'slack-reports', available: true, checkedAt: checkedAt.toISOString(),
        count24h: Number(row.count_24h), count48h: Number(row.count_48h),
        lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
        failed: Number(row.failed), overdue: Number(row.overdue)});
    } catch {
      return res.status(503).json({error: 'monitoring unavailable'});
    }
  });
}
