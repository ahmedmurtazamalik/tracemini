import type {DB} from './db.js';
import {materializeDueReportSchedules} from './report-schedule.js';

const onlineWindowMs = 2 * 60_000;
const generationTimeoutMs = 5 * 60_000;
const scheduledWorkspaceJob = (job: any) => job.report_scope === 'workspace' && Boolean(job.scheduled_for);
const attemptedAgents = (job: any): number[] => (typeof job.attempted_agent_ids === 'string' ? JSON.parse(job.attempted_agent_ids) : job.attempted_agent_ids || []).map(Number);

// The requester still authorizes workspace scope. Only scheduled jobs may run
// on another member's device; manual and personal jobs retain their ownership.
const accessibleJobs = `FROM report_jobs j
  JOIN workspace_members caller ON caller.workspace_id=j.workspace_id AND caller.user_id=?
  JOIN workspace_members owner ON owner.workspace_id=j.workspace_id AND owner.user_id=j.user_id
  WHERE (j.user_id=? OR (j.report_scope='workspace' AND j.scheduled_for IS NOT NULL))
    AND (j.report_scope<>'workspace' OR owner.role='Manager')`;

async function nextScheduledDevice(db: DB, job: any, at = new Date()) {
  const devices = await db.prepare(`SELECT a.* FROM agents a JOIN workspace_members wm ON wm.user_id=a.user_id
    WHERE wm.workspace_id=? AND a.revoked_at IS NULL ORDER BY CASE WHEN a.user_id=? THEN 0 ELSE 1 END,a.id`).all(job.workspace_id, job.user_id);
  const remaining = devices.filter(device => !attemptedAgents(job).includes(Number(device.id)));
  return {remaining, device: remaining.find(device => new Date(device.last_seen || 0).getTime() > at.getTime() - onlineWindowMs)};
}

export function runningReportJob(db: DB, agent: any, jobId: unknown, lock = false) {
  return db.prepare(`SELECT j.* ${accessibleJobs} AND j.id=? AND j.agent_id=? AND j.status='running'${lock ? ' FOR UPDATE' : ''}`)
    .get(agent.user_id, agent.user_id, jobId, agent.id);
}

export async function pendingReportJobs(db: DB, agent: any, at = new Date()) {
  await materializeDueReportSchedules(db, agent.user_id, at);
  const jobs = await db.prepare(`SELECT j.* ${accessibleJobs} AND (j.status='pending' OR (j.status='running' AND j.report_scope='workspace' AND j.scheduled_for IS NOT NULL)) ORDER BY j.id`)
    .all(agent.user_id, agent.user_id);
  for (const candidate of jobs) {
    const available = await db.transaction(async () => {
      const job: any = await db.prepare(`SELECT j.* ${accessibleJobs} AND j.id=? FOR UPDATE`).get(agent.user_id, agent.user_id, candidate.id);
      if (!job || !['pending', 'running'].includes(job.status)) return;
      if (!scheduledWorkspaceJob(job)) return job.status === 'pending' ? job : undefined;
      if (job.status === 'running') {
        const device: any = await db.prepare(`SELECT a.* FROM agents a JOIN workspace_members wm ON wm.user_id=a.user_id
          WHERE a.id=? AND wm.workspace_id=? AND a.revoked_at IS NULL`).get(job.agent_id, job.workspace_id);
        if (device && new Date(device.last_seen || 0).getTime() > at.getTime() - onlineWindowMs
          && new Date(job.claimed_at).getTime() > at.getTime() - generationTimeoutMs) return;
        // Remember legacy claims too, so a disconnected device is not retried.
        job.attempted_agent_ids = [...new Set([...attemptedAgents(job), Number(job.agent_id)].filter(Boolean))];
        await db.prepare("UPDATE report_jobs SET status='pending',agent_id=NULL,claimed_at=NULL,attempted_agent_ids=?,error='Reporting device disconnected or timed out' WHERE id=?")
          .run(JSON.stringify(job.attempted_agent_ids), job.id);
        job.status = 'pending';
      }
      const {remaining, device} = await nextScheduledDevice(db, job, at);
      if (!remaining.length && attemptedAgents(job).length) {
        await db.prepare("UPDATE report_jobs SET status='failed',completed_at=?,error='Report generation failed on all available workspace devices' WHERE id=?").run(at.toISOString(), job.id);
        return;
      }
      return Number(device?.id) === Number(agent.id) ? job : undefined;
    });
    if (available) return [available];
  }
  return [];
}

export async function claimReportJob(db: DB, agent: any, jobId: unknown) {
  return db.transaction(async () => {
    const job: any = await db.prepare(`SELECT j.* ${accessibleJobs} AND j.id=? AND j.status='pending' FOR UPDATE`).get(agent.user_id, agent.user_id, jobId);
    if (!job) return;
    if (scheduledWorkspaceJob(job)) {
      const {device} = await nextScheduledDevice(db, job);
      if (Number(device?.id) !== Number(agent.id)) return;
    }
    return db.prepare("UPDATE report_jobs SET status='running',agent_id=?,claimed_at=?,completed_at=NULL,error=NULL,attempted_agent_ids=? WHERE id=? AND status='pending' RETURNING *")
      .get(agent.id, new Date().toISOString(), JSON.stringify([...attemptedAgents(job), Number(agent.id)]), job.id);
  });
}

export async function failReportJob(db: DB, job: any, error: string) {
  const attempts = [...new Set([...attemptedAgents(job), Number(job.agent_id)].filter(Boolean))];
  const scheduled = scheduledWorkspaceJob(job);
  const retry = scheduled && (await nextScheduledDevice(db, {...job, attempted_agent_ids: attempts})).remaining.length > 0;
  return db.prepare("UPDATE report_jobs SET status=?,error=?,completed_at=?,agent_id=?,claimed_at=?,attempted_agent_ids=? WHERE id=? AND agent_id=? AND status='running'")
    .run(retry ? 'pending' : 'failed', scheduled ? (retry ? 'Trying another workspace device' : 'Report generation failed on all available workspace devices') : error,
      retry ? null : new Date().toISOString(), retry ? null : job.agent_id, retry ? null : job.claimed_at, JSON.stringify(attempts), job.id, job.agent_id);
}
