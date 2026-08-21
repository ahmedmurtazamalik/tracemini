import express, {type NextFunction, type Request, type Response} from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {DB} from './db.js';
import {linuxInstallCommand, linuxInstaller} from './linux-installer.js';

const now = () => new Date().toISOString();
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');

export function normalizeRemote(value: string) {
  let normalized = value.trim().replace(/\\/g, '/').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  const scp = normalized.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !normalized.includes('://')) normalized = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(normalized);
      normalized = url.protocol === 'file:' ? `file://${url.pathname}` : `${url.hostname}${url.pathname}`;
    } catch {}
  }
  return normalized.replace(/^\/+/, '').toLowerCase();
}

type Authed = Request & {user?: any; agent?: any};
const required = (keys: string[]) => (req: Request, res: Response, next: NextFunction) => {
  for (const key of keys) {
    if (typeof req.body?.[key] !== 'string' || !req.body[key].trim()) {
      return res.status(400).json({error: `${key} is required`});
    }
  }
  next();
};

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultCliDir = path.resolve(moduleDirectory, '../../../packages/cli/dist');

export function createApp(db: DB, webDir?: string, cliDir = defaultCliDir) {
  const app = express();
  app.use(express.json({limit: '512kb'}));

  const userAuth = (req: Authed, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const row = raw && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(hash(raw));
    if (!row) return res.status(401).json({error: 'unauthorized'});
    req.user = row;
    next();
  };
  const agentAuth = (req: Authed, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const row: any = raw && db.prepare("SELECT a.*,u.name user_name FROM agents a JOIN users u ON u.id=a.user_id WHERE a.token_hash=? AND a.revoked_at IS NULL AND (a.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=a.workspace_id AND wm.user_id=a.user_id))").get(hash(raw));
    if (!row) return res.status(401).json({error: 'unauthorized agent'});
    req.agent = row;
    db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(now(), row.id);
    next();
  };
  const membership = (userId: number, workspaceId: number) => db.prepare('SELECT * FROM workspace_members WHERE user_id=? AND workspace_id=?').get(userId, workspaceId) as any;
  const requireMember = (req: Authed, res: Response, next: NextFunction) => {
    const workspaceId = Number(req.params.id || req.params.workspaceId || req.body?.workspaceId);
    if (!membership(req.user.id, workspaceId)) return res.status(403).json({error: 'forbidden'});
    next();
  };
  const requireManager = (req: Authed, res: Response, next: NextFunction) => {
    const workspaceId = Number(req.params.id || req.params.workspaceId);
    if (membership(req.user.id, workspaceId)?.role !== 'Manager') return res.status(403).json({error: 'Manager required'});
    next();
  };
  const managerCount = (workspaceId: number) => (db.prepare("SELECT COUNT(*) count FROM workspace_members WHERE workspace_id=? AND role='Manager'").get(workspaceId) as any).count as number;

  app.get('/api/health', (_req, res) => res.json({ok: true}));
  app.post('/api/auth/register', required(['name', 'email', 'password']), (req, res) => {
    try {
      const result = db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES(?,?,?,?)').run(req.body.name.trim(), req.body.email.trim().toLowerCase(), bcrypt.hashSync(req.body.password, 10), now());
      const raw = token();
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), result.lastInsertRowid, now());
      res.status(201).json({token: raw, user: {id: Number(result.lastInsertRowid), name: req.body.name, email: req.body.email.toLowerCase()}});
    } catch {
      res.status(409).json({error: 'email already registered'});
    }
  });
  app.post('/api/auth/login', required(['email', 'password']), (req, res) => {
    const user: any = db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email.trim().toLowerCase());
    if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) return res.status(401).json({error: 'invalid credentials'});
    const raw = token();
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), user.id, now());
    res.json({token: raw, user: {id: user.id, name: user.name, email: user.email}});
  });
  app.post('/api/auth/logout', userAuth, (req: Authed, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.headers.authorization!.replace(/^Bearer\s+/i, '')));
    res.status(204).end();
  });
  app.get('/api/auth/me', userAuth, (req: Authed, res) => res.json({id: req.user.id, name: req.user.name, email: req.user.email}));

  app.post('/api/workspaces', userAuth, required(['name']), (req: Authed, res) => {
    const inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const id = Number(db.transaction(() => {
      const result = db.prepare('INSERT INTO workspaces(name,owner_id,invite_code,created_at) VALUES(?,?,?,?)').run(req.body.name.trim(), req.user.id, inviteCode, now());
      db.prepare("INSERT INTO workspace_members VALUES(?,?,'Manager')").run(result.lastInsertRowid, req.user.id);
      return result.lastInsertRowid;
    })());
    res.status(201).json({id, name: req.body.name.trim(), inviteCode});
  });
  app.post('/api/workspaces/join', userAuth, required(['inviteCode']), (req: Authed, res) => {
    const workspace: any = db.prepare('SELECT * FROM workspaces WHERE invite_code=? AND invite_enabled=1').get(req.body.inviteCode.trim().toUpperCase());
    if (!workspace) return res.status(404).json({error: 'invalid or disabled invite code'});
    db.prepare("INSERT OR IGNORE INTO workspace_members VALUES(?,?,'Member')").run(workspace.id, req.user.id);
    res.json(workspace);
  });
  app.get('/api/workspaces', userAuth, (req: Authed, res) => res.json(db.prepare('SELECT w.*,wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=? ORDER BY w.id').all(req.user.id)));
  app.get('/api/workspaces/:id/members', userAuth, requireMember, (req, res) => res.json(db.prepare('SELECT u.id,u.name,u.email,wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? ORDER BY u.name').all(req.params.id)));
  app.patch('/api/workspaces/:id/members/:userId', userAuth, requireManager, (req: Authed, res) => {
    if (!['Manager', 'Member'].includes(req.body.role)) return res.status(400).json({error: 'role must be Manager or Member'});
    const current: any = db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.params.userId);
    if (!current) return res.status(404).json({error: 'member not found'});
    if (current.role === 'Manager' && req.body.role === 'Member' && managerCount(+req.params.id) === 1) return res.status(409).json({error: 'workspace must retain a Manager'});
    db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run(req.body.role, req.params.id, req.params.userId);
    res.json({ok: true, role: req.body.role});
  });
  app.delete('/api/workspaces/:id/members/:userId', userAuth, requireManager, (req: Authed, res) => {
    const current: any = db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.params.userId);
    if (!current) return res.status(404).json({error: 'member not found'});
    if (current.role === 'Manager' && managerCount(+req.params.id) === 1) return res.status(409).json({error: 'workspace must retain a Manager'});
    db.transaction(() => {
      const agentIds = db.prepare('SELECT id FROM agents WHERE workspace_id=? AND user_id=?').all(req.params.id, req.params.userId).map((row: any) => row.id);
      for (const agentId of agentIds) {
        db.prepare("UPDATE refresh_requests SET status='error',error='workspace membership removed',completed_at=? WHERE agent_id=? AND status IN ('queued','running')").run(now(), agentId);
        db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND status='pending'").run(now(), agentId);
      }
      db.prepare('UPDATE agents SET revoked_at=? WHERE workspace_id=? AND user_id=? AND revoked_at IS NULL').run(now(), req.params.id, req.params.userId);
      db.prepare("UPDATE report_jobs SET status='failed',error='workspace membership removed',completed_at=? WHERE workspace_id=? AND user_id=? AND status IN ('pending','running')").run(now(), req.params.id, req.params.userId);
      db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(req.params.id, req.params.userId);
    })();
    res.status(204).end();
  });
  app.post('/api/workspaces/:id/invite/regenerate', userAuth, requireManager, (req, res) => {
    const inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    db.prepare('UPDATE workspaces SET invite_code=?,invite_enabled=1 WHERE id=?').run(inviteCode, req.params.id);
    res.json({inviteCode});
  });
  app.post('/api/workspaces/:id/invite/disable', userAuth, requireManager, (req, res) => {
    db.prepare('UPDATE workspaces SET invite_enabled=0 WHERE id=?').run(req.params.id);
    res.json({ok: true});
  });
  app.delete('/api/workspaces/:id', userAuth, requireManager, (req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM pending_pushes WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      db.prepare('DELETE FROM activity_events WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      db.prepare('DELETE FROM local_clones WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      db.prepare('DELETE FROM reports WHERE workspace_id=?').run(req.params.id);
      db.prepare('DELETE FROM report_jobs WHERE workspace_id=?').run(req.params.id);
      db.prepare('DELETE FROM repositories WHERE workspace_id=?').run(req.params.id);
      db.prepare('DELETE FROM workspaces WHERE id=?').run(req.params.id);
    })();
    res.status(204).end();
  });

  app.post('/api/agents/installations', userAuth, (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (!membership(req.user.id, workspaceId)) return res.status(403).json({error: 'forbidden'});
    const raw = token();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    db.prepare('INSERT INTO setup_codes(code_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)').run(hash(raw), req.user.id, workspaceId, expiresAt, now());
    const origin = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({installCommand: linuxInstallCommand(origin, raw), expiresAt});
  });
  app.get('/api/installers/linux/:installToken', (req, res) => {
    const setup: any = db.prepare('SELECT * FROM setup_codes WHERE code_hash=?').get(hash(req.params.installToken));
    if (!setup || setup.used_at || setup.expires_at <= now()) return res.status(410).type('text/plain').send('Install token invalid, expired, or already used.\n');
    try {
      res.type('text/x-shellscript').set('content-disposition', 'attachment; filename="tracemini-install.sh"').send(linuxInstaller(cliDir, `${req.protocol}://${req.get('host')}`, req.params.installToken));
    } catch (error: any) {
      res.status(503).json({error: error.message});
    }
  });
  app.post('/api/agents/install/exchange', required(['installToken', 'machineName']), (req, res) => {
    const setup: any = db.prepare('SELECT * FROM setup_codes WHERE code_hash=?').get(hash(req.body.installToken));
    if (!setup || setup.used_at || setup.expires_at <= now()) return res.status(409).json({error: 'install token invalid, expired, or already used'});
    const agentToken = token();
    const agentId = db.transaction(() => {
      const consumed = db.prepare('UPDATE setup_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?').run(now(), setup.code_hash, now());
      if (!consumed.changes) return undefined;
      const result = db.prepare('INSERT INTO agents(user_id,workspace_id,machine_name,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?)').run(setup.user_id, setup.workspace_id, req.body.machineName.trim(), hash(agentToken), now(), now());
      return Number(result.lastInsertRowid);
    })();
    if (!agentId) return res.status(409).json({error: 'install token invalid, expired, or already used'});
    res.status(201).json({agentId, agentToken, workspaceId: setup.workspace_id});
  });
  app.post('/api/agents/register', userAuth, required(['machineName']), (req: Authed, res) => {
    const raw = token();
    const result = db.prepare('INSERT INTO agents(user_id,machine_name,token_hash,last_seen,created_at) VALUES(?,?,?,?,?)').run(req.user.id, req.body.machineName, hash(raw), now(), now());
    res.status(201).json({agentId: Number(result.lastInsertRowid), token: raw});
  });
  app.post('/api/agents/workspace', agentAuth, required(['workspaceId']), (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (!membership(req.agent.user_id, workspaceId)) return res.status(403).json({error: 'forbidden'});
    db.transaction(() => {
      if (req.agent.workspace_id && req.agent.workspace_id !== workspaceId) {
        db.prepare("UPDATE refresh_requests SET status='error',error='agent changed workspace',completed_at=? WHERE agent_id=? AND status IN ('queued','running')").run(now(), req.agent.id);
        db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND status='pending'").run(now(), req.agent.id);
        db.prepare("UPDATE report_jobs SET status='failed',error='agent changed workspace',completed_at=? WHERE agent_id=? AND status='running'").run(now(), req.agent.id);
      }
      db.prepare('UPDATE agents SET workspace_id=? WHERE id=?').run(workspaceId, req.agent.id);
    })();
    res.json({ok: true, workspaceId});
  });
  app.get('/api/agents/status', agentAuth, (req: Authed, res) => res.json({id: req.agent.id, userId: req.agent.user_id, workspaceId: req.agent.workspace_id, machineName: req.agent.machine_name, lastSeen: req.agent.last_seen}));
  app.post('/api/agents/heartbeat', agentAuth, (_req, res) => res.json({ok: true, at: now()}));
  app.get('/api/workspaces/:id/agents', userAuth, requireMember, (req, res) => {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const rows = db.prepare("SELECT a.id,a.machine_name,a.last_seen,a.revoked_at,u.name user_name,CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' WHEN a.last_seen>=? THEN 'online' ELSE 'offline' END status FROM agents a JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.id").all(cutoff, req.params.id);
    res.json(rows);
  });
  app.post('/api/workspaces/:id/agents/:agentId/revoke', userAuth, requireManager, (req, res) => {
    const agent: any = db.prepare('SELECT id FROM agents WHERE id=? AND workspace_id=?').get(req.params.agentId, req.params.id);
    if (!agent) return res.status(404).json({error: 'agent not found'});
    db.transaction(() => {
      db.prepare("UPDATE refresh_requests SET status='error',error='agent revoked',completed_at=? WHERE agent_id=? AND status IN ('queued','running')").run(now(), agent.id);
      db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND status='pending'").run(now(), agent.id);
      db.prepare("UPDATE report_jobs SET status='failed',error='agent revoked',completed_at=? WHERE agent_id=? AND status='running'").run(now(), agent.id);
      db.prepare('UPDATE agents SET revoked_at=? WHERE id=?').run(now(), agent.id);
    })();
    res.json({ok: true});
  });

  app.post('/api/repositories/register', agentAuth, required(['workspaceId', 'name', 'remoteUrl', 'localKey']), (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (req.agent.workspace_id !== workspaceId) return res.status(403).json({error: 'agent belongs to another workspace'});
    const normalized = normalizeRemote(req.body.remoteUrl);
    if (!normalized) return res.status(400).json({error: 'remote URL required'});
    db.prepare('INSERT OR IGNORE INTO repositories(workspace_id,name,remote_url,normalized_remote,created_at) VALUES(?,?,?,?,?)').run(workspaceId, req.body.name, req.body.remoteUrl, normalized, now());
    const repository: any = db.prepare('SELECT * FROM repositories WHERE workspace_id=? AND normalized_remote=?').get(workspaceId, normalized);
    db.prepare('INSERT INTO local_clones(agent_id,repository_id,local_key,branch,last_seen,head_sha,remote_head_sha) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,local_key) DO UPDATE SET repository_id=excluded.repository_id,branch=excluded.branch,last_seen=excluded.last_seen,head_sha=excluded.head_sha,remote_head_sha=excluded.remote_head_sha').run(req.agent.id, repository.id, req.body.localKey, req.body.branch || null, now(), req.body.headSha || null, req.body.remoteHeadSha || null);
    res.json(repository);
  });
  app.get('/api/workspaces/:id/repositories', userAuth, requireMember, (req, res) => {
    const archived = req.query.includeArchived === 'true' ? '' : ' AND r.archived=0';
    res.json(db.prepare(`SELECT r.*,COUNT(lc.id) clone_count FROM repositories r LEFT JOIN local_clones lc ON lc.repository_id=r.id WHERE r.workspace_id=?${archived} GROUP BY r.id ORDER BY r.name`).all(req.params.id));
  });
  app.patch('/api/workspaces/:id/repositories/:repositoryId', userAuth, requireManager, (req, res) => {
    if (typeof req.body.archived !== 'boolean') return res.status(400).json({error: 'archived boolean required'});
    const result = db.prepare('UPDATE repositories SET archived=? WHERE id=? AND workspace_id=?').run(req.body.archived ? 1 : 0, req.params.repositoryId, req.params.id);
    if (!result.changes) return res.status(404).json({error: 'repository not found'});
    res.json({ok: true});
  });

  app.post('/api/workspaces/:id/refresh', userAuth, requireMember, (req: Authed, res) => {
    const agents = db.prepare('SELECT id FROM agents WHERE workspace_id=? AND revoked_at IS NULL ORDER BY id').all(req.params.id) as {id: number}[];
    const ids = db.transaction(() => {
      const targets: Array<number | null> = agents.length ? agents.map(agent => agent.id) : [null];
      return targets.map(agentId => Number(db.prepare("INSERT INTO refresh_requests(workspace_id,requested_by,agent_id,status,created_at) VALUES(?,?,?,'queued',?)").run(req.params.id, req.user.id, agentId, now()).lastInsertRowid));
    })();
    res.status(201).json({id: ids[0], ids, requestCount: ids.length, status: 'queued'});
  });
  app.get('/api/workspaces/:id/refresh', userAuth, requireMember, (req, res) => res.json(db.prepare('SELECT * FROM refresh_requests WHERE workspace_id=? ORDER BY id DESC LIMIT 20').all(req.params.id)));
  app.get('/api/agents/refresh-requests', agentAuth, (req: Authed, res) => res.json(req.agent.workspace_id ? db.prepare("SELECT rr.* FROM refresh_requests rr WHERE rr.workspace_id=? AND (rr.agent_id=? OR rr.agent_id IS NULL) AND rr.status='queued' ORDER BY rr.id LIMIT 1").all(req.agent.workspace_id, req.agent.id) : []));
  app.post('/api/agents/refresh-requests/:requestId/claim', agentAuth, (req: Authed, res) => {
    const result = db.prepare("UPDATE refresh_requests SET status='running',agent_id=?,claimed_at=? WHERE id=? AND status='queued' AND (agent_id=? OR agent_id IS NULL) AND workspace_id=?").run(req.agent.id, now(), req.params.requestId, req.agent.id, req.agent.workspace_id);
    if (!result.changes) return res.status(409).json({error: 'refresh unavailable'});
    res.json({ok: true});
  });
  app.post('/api/agents/refresh-requests/:requestId/complete', agentAuth, (req: Authed, res) => {
    const status = req.body.error ? 'error' : 'completed';
    const result = db.prepare("UPDATE refresh_requests SET status=?,repositories_found=?,error=?,completed_at=? WHERE id=? AND agent_id=? AND status='running'").run(status, Number(req.body.repositoriesFound) || 0, req.body.error || null, now(), req.params.requestId, req.agent.id);
    if (!result.changes) return res.status(409).json({error: 'refresh not claimed'});
    res.json({ok: true});
  });

  app.post('/api/pushes/pending', agentAuth, required(['eventKey', 'remoteName', 'remoteUrl', 'ref', 'expectedSha', 'occurredAt']), (req: Authed, res) => {
    const repository: any = db.prepare('SELECT * FROM repositories WHERE id=? AND workspace_id=?').get(req.body.repositoryId, req.agent.workspace_id);
    if (!repository) return res.status(403).json({error: 'repository not available'});
    const result = db.prepare("INSERT OR IGNORE INTO pending_pushes(event_key,user_id,agent_id,repository_id,remote_name,remote_url,ref,expected_sha,status,occurred_at) VALUES(?,?,?,?,?,?,?,?, 'pending',?)").run(req.body.eventKey, req.agent.user_id, req.agent.id, repository.id, req.body.remoteName, req.body.remoteUrl, req.body.ref, req.body.expectedSha, req.body.occurredAt);
    const push = db.prepare('SELECT * FROM pending_pushes WHERE event_key=?').get(req.body.eventKey);
    res.status(result.changes ? 201 : 200).json(push);
  });
  app.get('/api/agents/pushes', agentAuth, (req: Authed, res) => res.json(db.prepare("SELECT * FROM pending_pushes WHERE agent_id=? AND status='pending' AND (next_check_at IS NULL OR next_check_at<=?) ORDER BY id LIMIT 10").all(req.agent.id, now())));
  app.post('/api/agents/pushes/:pushId/complete', agentAuth, (req: Authed, res) => {
    if (!['confirmed', 'unconfirmed'].includes(req.body.status)) return res.status(400).json({error: 'invalid status'});
    const push: any = db.prepare("SELECT * FROM pending_pushes WHERE id=? AND agent_id=? AND status='pending'").get(req.params.pushId, req.agent.id);
    if (!push) return res.status(409).json({error: 'push unavailable'});
    if (req.body.status === 'unconfirmed' && push.attempts < 2) {
      const nextCheckAt = new Date(Date.now() + 10_000).toISOString();
      db.prepare('UPDATE pending_pushes SET attempts=attempts+1,next_check_at=? WHERE id=?').run(nextCheckAt, push.id);
      return res.json({ok: true, retrying: true, nextCheckAt});
    }
    db.transaction(() => {
      db.prepare('UPDATE pending_pushes SET status=?,observed_sha=?,completed_at=? WHERE id=?').run(req.body.status, req.body.observedSha || null, now(), push.id);
      db.prepare('INSERT OR IGNORE INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?)').run(push.event_key, push.user_id, push.agent_id, push.repository_id, 'push', push.occurred_at, JSON.stringify({remote: push.remote_name, remoteUrl: push.remote_url, ref: push.ref, expectedSha: push.expected_sha, observedSha: req.body.observedSha || null, confirmation: req.body.status}), now());
    })();
    res.json({ok: true});
  });

  app.post('/api/activity', agentAuth, required(['eventKey', 'type', 'occurredAt']), (req: Authed, res) => {
    const repositoryId = Number(req.body.repositoryId);
    const repository: any = db.prepare('SELECT * FROM repositories WHERE id=? AND workspace_id=?').get(repositoryId, req.agent.workspace_id);
    if (!repository) return res.status(403).json({error: 'repository not available'});
    const result = db.prepare('INSERT OR IGNORE INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?)').run(req.body.eventKey, req.agent.user_id, req.agent.id, repository.id, req.body.type, req.body.occurredAt, JSON.stringify(req.body.data || {}), now());
    res.status(result.changes ? 201 : 200).json({accepted: Boolean(result.changes)});
  });
  const queryActivity = (req: Authed, res: Response, extra: string, args: any[]) => {
    const workspaceId = Number(req.params.workspaceId || req.query.workspaceId || 0);
    if (!workspaceId || !membership(req.user.id, workspaceId)) return res.status(403).json({error: 'forbidden'});
    let sql = 'SELECT e.*,u.name user_name,r.name repository_name FROM activity_events e JOIN users u ON u.id=e.user_id JOIN repositories r ON r.id=e.repository_id WHERE r.workspace_id=?' + extra;
    const values: any[] = [workspaceId, ...args];
    if (req.query.from) { sql += ' AND e.occurred_at>=?'; values.push(String(req.query.from)); }
    if (req.query.to) { sql += ' AND e.occurred_at<=?'; values.push(`${String(req.query.to)}T23:59:59.999Z`); }
    sql += ' ORDER BY e.occurred_at DESC LIMIT 500';
    res.json(db.prepare(sql).all(...values).map((row: any) => ({...row, data: JSON.parse(row.data)})));
  };
  app.get('/api/workspaces/:workspaceId/activity', userAuth, (req: Authed, res) => queryActivity(req, res, '', []));
  app.get('/api/repositories/:id/activity', userAuth, (req: Authed, res) => queryActivity(req, res, ' AND e.repository_id=?', [+req.params.id]));
  app.get('/api/users/:id/activity', userAuth, (req: Authed, res) => queryActivity(req, res, ' AND e.user_id=?', [+req.params.id]));
  app.get('/api/workspaces/:id/stats', userAuth, requireMember, (req, res) => {
    const filters: string[] = ["r.workspace_id=?", "e.type='commit'"];
    const values: any[] = [req.params.id];
    if (req.query.userId) { filters.push('e.user_id=?'); values.push(req.query.userId); }
    if (req.query.repositoryId) { filters.push('e.repository_id=?'); values.push(req.query.repositoryId); }
    if (req.query.from) { filters.push('e.occurred_at>=?'); values.push(req.query.from); }
    if (req.query.to) { filters.push('e.occurred_at<=?'); values.push(`${req.query.to}T23:59:59.999Z`); }
    const where = filters.join(' AND ');
    const totals: any = db.prepare(`SELECT COUNT(*) commits,COALESCE(SUM(CAST(json_extract(e.data,'$.filesChanged') AS INTEGER)),0) filesChanged,COALESCE(SUM(CAST(json_extract(e.data,'$.insertions') AS INTEGER)),0) insertions,COALESCE(SUM(CAST(json_extract(e.data,'$.deletions') AS INTEGER)),0) deletions FROM activity_events e JOIN repositories r ON r.id=e.repository_id WHERE ${where}`).get(...values);
    const daily = db.prepare(`SELECT substr(e.occurred_at,1,10) date,COUNT(*) commits,COALESCE(SUM(CAST(json_extract(e.data,'$.filesChanged') AS INTEGER)),0) filesChanged,COALESCE(SUM(CAST(json_extract(e.data,'$.insertions') AS INTEGER)),0) insertions,COALESCE(SUM(CAST(json_extract(e.data,'$.deletions') AS INTEGER)),0) deletions FROM activity_events e JOIN repositories r ON r.id=e.repository_id WHERE ${where} GROUP BY date ORDER BY date`).all(...values);
    res.json({totals, daily});
  });

  app.post('/api/reports/jobs', userAuth, required(['workspaceId', 'startDate', 'endDate', 'reporter']), (req: Authed, res) => {
    if (!membership(req.user.id, +req.body.workspaceId)) return res.status(403).json({error: 'forbidden'});
    if (!['codex', 'hermes'].includes(req.body.reporter)) return res.status(400).json({error: 'invalid reporter'});
    const result = db.prepare("INSERT INTO report_jobs(workspace_id,user_id,reporter,start_date,end_date,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(req.body.workspaceId, req.user.id, req.body.reporter, req.body.startDate, req.body.endDate, now());
    res.status(201).json({id: Number(result.lastInsertRowid), status: 'pending'});
  });
  app.get('/api/reports/jobs/:id', userAuth, (req: Authed, res) => { const row = db.prepare('SELECT * FROM report_jobs WHERE id=? AND user_id=?').get(req.params.id, req.user.id); row ? res.json(row) : res.status(404).json({error: 'not found'}); });
  app.get('/api/agents/jobs', agentAuth, (req: Authed, res) => res.json(db.prepare("SELECT * FROM report_jobs WHERE user_id=? AND workspace_id=? AND status='pending' ORDER BY id LIMIT 1").all(req.agent.user_id, req.agent.workspace_id)));
  app.post('/api/agents/jobs/:id/claim', agentAuth, (req: Authed, res) => { const result = db.prepare("UPDATE report_jobs SET status='running',agent_id=?,claimed_at=? WHERE id=? AND user_id=? AND workspace_id=? AND status='pending'").run(req.agent.id, now(), req.params.id, req.agent.user_id, req.agent.workspace_id); result.changes ? res.json(db.prepare('SELECT * FROM report_jobs WHERE id=?').get(req.params.id)) : res.status(409).json({error: 'job unavailable'}); });
  app.get('/api/agents/jobs/:id/context', agentAuth, (req: Authed, res) => {
    const job: any = db.prepare('SELECT * FROM report_jobs WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=?').get(req.params.id, req.agent.user_id, req.agent.workspace_id, req.agent.id);
    if (!job) return res.status(404).json({error: 'not found'});
    const events = db.prepare('SELECT e.*,r.name repository_name,r.normalized_remote FROM activity_events e JOIN repositories r ON r.id=e.repository_id WHERE e.user_id=? AND r.workspace_id=? AND e.occurred_at>=? AND e.occurred_at<=? ORDER BY e.occurred_at').all(job.user_id, job.workspace_id, job.start_date, `${job.end_date}T23:59:59.999Z`).map((row: any) => ({...row, data: JSON.parse(row.data)}));
    res.json({job, events});
  });
  app.post('/api/agents/jobs/:id/complete', agentAuth, required(['markdown']), (req: Authed, res) => {
    const job: any = db.prepare("SELECT * FROM report_jobs WHERE id=? AND user_id=? AND workspace_id=? AND status='running' AND agent_id=?").get(req.params.id, req.agent.user_id, req.agent.workspace_id, req.agent.id);
    if (!job) return res.status(409).json({error: 'job not claimed'});
    db.transaction(() => { db.prepare('INSERT INTO reports(job_id,workspace_id,user_id,start_date,end_date,markdown,created_at) VALUES(?,?,?,?,?,?,?)').run(job.id, job.workspace_id, job.user_id, job.start_date, job.end_date, req.body.markdown, now()); db.prepare("UPDATE report_jobs SET status='completed',completed_at=? WHERE id=?").run(now(), job.id); })();
    res.status(201).json({ok: true});
  });
  app.post('/api/agents/jobs/:id/fail', agentAuth, required(['error']), (req: Authed, res) => { const result = db.prepare("UPDATE report_jobs SET status='failed',error=?,completed_at=? WHERE id=? AND user_id=? AND workspace_id=? AND agent_id=? AND status='running'").run(req.body.error, now(), req.params.id, req.agent.user_id, req.agent.workspace_id, req.agent.id); res.status(result.changes ? 200 : 409).json({ok: Boolean(result.changes)}); });
  app.get('/api/workspaces/:id/reports', userAuth, requireMember, (req, res) => res.json(db.prepare('SELECT r.*,u.name user_name FROM reports r JOIN users u ON u.id=r.user_id WHERE workspace_id=? ORDER BY created_at DESC').all(req.params.id)));
  app.get('/api/reports/:id', userAuth, (req: Authed, res) => { const row = db.prepare('SELECT r.* FROM reports r JOIN workspace_members wm ON wm.workspace_id=r.workspace_id WHERE r.id=? AND wm.user_id=?').get(req.params.id, req.user.id); row ? res.json(row) : res.status(404).json({error: 'not found'}); });

  if (webDir && fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api/')) return res.status(404).json({error: 'not found'});
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    res.status(500).json({error: 'internal error'});
  });
  return app;
}
