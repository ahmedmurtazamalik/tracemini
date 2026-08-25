import express, {type NextFunction, type Request, type Response} from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {DB} from './db.js';
import {linuxInstallCommand, linuxInstaller, linuxSyncCommand} from './linux-installer.js';
import {dateKeyInTimezone, dateRangeUtc, normalizeTimezone} from './timezone.js';

const now = () => new Date().toISOString();
const expired = (value: string | Date) => new Date(value).getTime() <= Date.now();
const eventData = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;
const isoDate = (value: string | Date) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toISOString().slice(0, 10);
const defaultReportName = (startDate: string | Date, endDate: string | Date) => `Engineering contributions · ${isoDate(startDate)} — ${isoDate(endDate)}`;
const reportOutput = (row: any) => ({...row, start_date: isoDate(row.start_date), end_date: isoDate(row.end_date)});
const instant = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};
const dateOnly = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');
const uniqueViolationText = (error: any) => `${error?.constraint || ''} ${error?.detail || ''} ${error?.message || ''}`;
const inviteCodeCollision = (error: any) => error?.code === '23505' && /invite_code|workspaces_invite_code_key/i.test(uniqueViolationText(error));
const emailCollision = (error: any) => error?.code === '23505' && /users_email_key|users.*email|email.*users/i.test(uniqueViolationText(error));

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

export function requestOrigin(req: Request, hosted = Boolean(process.env.VERCEL)) {
  return `${hosted ? 'https' : req.protocol}://${req.get('host')}`;
}

export function createApp(db: DB, webDir?: string, cliDir = defaultCliDir) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({limit: '512kb'}));

  const userAuth = async (req: Authed, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const row = raw && await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id AND u.auth_version=s.auth_version WHERE s.token_hash=?').get(hash(raw));
    if (!row) return res.status(401).json({error: 'unauthorized'});
    req.user = row;
    next();
  };
  const agentAuth = async (req: Authed, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const row: any = raw && await db.prepare("SELECT a.*,u.name user_name FROM agents a JOIN users u ON u.id=a.user_id WHERE a.token_hash=? AND a.revoked_at IS NULL").get(hash(raw));
    if (!row) return res.status(401).json({error: 'unauthorized device'});
    req.agent = row;
    await db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(now(), row.id);
    next();
  };
  const membership = async (userId: number, workspaceId: number) => await db.prepare('SELECT * FROM workspace_members WHERE user_id=? AND workspace_id=?').get(userId, workspaceId) as any;
  const agentWorkspaceIds = async (userId: number) => (await db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=? ORDER BY workspace_id').all(userId)).map((row: any) => Number(row.workspace_id));
  const agentStatus = async (agent: any) => ({id: agent.id, userId: agent.user_id, workspaceId: agent.workspace_id, workspaceIds: await agentWorkspaceIds(agent.user_id), machineName: agent.machine_name, lastSeen: agent.last_seen});
  const requireMember = async (req: Authed, res: Response, next: NextFunction) => {
    const workspaceId = Number(req.params.id || req.params.workspaceId || req.body?.workspaceId);
    if (!(await membership(req.user.id, workspaceId))) return res.status(403).json({error: 'forbidden'});
    next();
  };
  const requireManager = async (req: Authed, res: Response, next: NextFunction) => {
    const workspaceId = Number(req.params.id || req.params.workspaceId);
    if ((await membership(req.user.id, workspaceId))?.role !== 'Manager') return res.status(403).json({error: 'Manager required'});
    next();
  };
  const managerCount = async (workspaceId: number) => (await db.prepare("SELECT COUNT(*)::INTEGER count FROM workspace_members WHERE workspace_id=? AND role='Manager'").get(workspaceId) as any).count as number;
  const hasLockedManagerAuthority = async (workspaceId: number, userId: number) => Boolean(await db.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager'").get(workspaceId, userId));
  const revokeDeviceWork = async (agentId: number, reason = 'device revoked') => {
    await db.prepare('UPDATE agents SET revoked_at=?,installation_id=NULL WHERE id=? AND revoked_at IS NULL').run(now(), agentId);
    await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND status='pending'").run(now(), agentId);
    await db.prepare("UPDATE report_jobs SET status='failed',error=?,completed_at=? WHERE agent_id=? AND status='running'").run(reason, now(), agentId);
  };
  const freshInviteCode = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      if (!(await db.prepare('SELECT 1 FROM workspaces WHERE invite_code=?').get(code))) return code;
    }
    throw new Error('could not allocate workspace invite code');
  };

  app.get('/api/health', async (_req, res, next) => {
    try {
      await db.query('SELECT 1');
      res.json({ok: true, database: 'ready'});
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/auth/register', required(['name', 'email', 'password']), async (req, res, next) => {
    try {
      const email = req.body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error: 'valid email required'});
      if (req.body.password.length < 8) return res.status(400).json({error: 'password must be at least 8 characters'});
      const raw = token();
      const name = req.body.name.trim();
      if (!name) return res.status(400).json({error: 'name required'});
      const passwordHash = await bcrypt.hash(req.body.password, 10);
      let created: {userId: number; workspaceId: number} | undefined;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        const personalInviteCode = await freshInviteCode();
        try {
          created = await db.transaction(async () => {
            const result = await db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES(?,?,?,?) RETURNING id').run(name, email, passwordHash, now());
            const userId = Number(result.lastInsertRowid);
            await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,auth_version) VALUES(?,?,?,0)').run(hash(raw), userId, now());
            const workspace = await db.prepare('INSERT INTO workspaces(name,owner_id,invite_code,created_at) VALUES(?,?,?,?) RETURNING id').run(`${name}'s workspace`, userId, personalInviteCode, now());
            const workspaceId = Number(workspace.lastInsertRowid);
            await db.prepare("INSERT INTO workspace_members VALUES(?,?,'Manager')").run(workspaceId, userId);
            return {userId, workspaceId};
          });
        } catch (error: any) {
          if (!inviteCodeCollision(error) || attempt === 2) throw error;
        }
      }
      if (!created) throw new Error('could not allocate workspace invite code');
      res.status(201).json({token: raw, user: {id: created.userId, name, email}, workspaceId: created.workspaceId});
    } catch (error: any) {
      if (emailCollision(error)) return res.status(409).json({error: 'email already registered'});
      next(error);
    }
  });
  app.post('/api/auth/login', required(['email', 'password']), async (req, res) => {
    const user: any = await db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email.trim().toLowerCase());
    if (!user || !await bcrypt.compare(req.body.password, user.password_hash)) return res.status(401).json({error: 'invalid credentials'});
    const raw = token();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,auth_version) VALUES(?,?,?,?)').run(hash(raw), user.id, now(), user.auth_version);
    res.json({token: raw, user: {id: user.id, name: user.name, email: user.email}});
  });
  app.post('/api/auth/logout', userAuth, async (req: Authed, res) => {
    await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.headers.authorization!.replace(/^Bearer\s+/i, '')));
    res.status(204).end();
  });
  app.get('/api/auth/me', userAuth, async (req: Authed, res) => res.json({id: req.user.id, name: req.user.name, email: req.user.email}));


  app.post('/api/workspaces', userAuth, required(['name']), async (req: Authed, res) => {
    const inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const id = Number(await db.transaction(async () => {
      const result = await db.prepare('INSERT INTO workspaces(name,owner_id,invite_code,created_at) VALUES(?,?,?,?) RETURNING id').run(req.body.name.trim(), req.user.id, inviteCode, now());
      await db.prepare("INSERT INTO workspace_members VALUES(?,?,'Manager')").run(result.lastInsertRowid, req.user.id);
      return result.lastInsertRowid;
    }));
    res.status(201).json({id, name: req.body.name.trim(), inviteCode});
  });
  app.post('/api/workspaces/join', userAuth, required(['inviteCode']), async (req: Authed, res) => {
    const workspace: any = await db.transaction(async () => {
      const selected = await db.prepare('SELECT * FROM workspaces WHERE invite_code=? AND invite_enabled=TRUE FOR UPDATE').get(req.body.inviteCode.trim().toUpperCase());
      if (!selected) return undefined;
      await db.prepare("INSERT INTO workspace_members VALUES(?,?,'Member') ON CONFLICT DO NOTHING").run(selected.id, req.user.id);
      return selected;
    });
    if (!workspace) return res.status(404).json({error: 'invalid or disabled invite code'});
    res.json(workspace);
  });
  app.get('/api/workspaces', userAuth, async (req: Authed, res) => res.json(await db.prepare('SELECT w.*,wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE wm.user_id=? ORDER BY w.id').all(req.user.id)));
  app.get('/api/workspaces/:id/members', userAuth, requireMember, async (req, res) => res.json(await db.prepare('SELECT u.id,u.name,u.email,wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? ORDER BY u.name').all(req.params.id)));
  app.patch('/api/workspaces/:id/members/:userId', userAuth, requireManager, async (req: Authed, res) => {
    if (!['Manager', 'Member'].includes(req.body.role)) return res.status(400).json({error: 'role must be Manager or Member'});
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return 'forbidden';
      const current: any = await db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.params.userId);
      if (!current) return 'missing';
      if (current.role === 'Manager' && req.body.role === 'Member' && await managerCount(+req.params.id) === 1) return 'last-manager';
      await db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?').run(req.body.role, req.params.id, req.params.userId);
      return 'updated';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'Manager required'});
    if (outcome === 'missing') return res.status(404).json({error: 'member not found'});
    if (outcome === 'last-manager') return res.status(409).json({error: 'workspace must retain a Manager'});
    res.json({ok: true, role: req.body.role});
  });
  app.delete('/api/workspaces/:id/members/:userId', userAuth, requireManager, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return 'forbidden';
      const current: any = await db.prepare('SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.params.userId);
      if (!current) return 'missing';
      if (current.role === 'Manager' && await managerCount(+req.params.id) === 1) return 'last-manager';
      const agentIds = (await db.prepare('SELECT id FROM agents WHERE user_id=?').all(req.params.userId)).map((row: any) => row.id);
      for (const agentId of agentIds) {
        await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?) AND status='pending'").run(now(), agentId, req.params.id);
        await db.prepare('DELETE FROM local_clones WHERE agent_id=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(agentId, req.params.id);
        await db.prepare('DELETE FROM repository_candidates WHERE agent_id=? AND workspace_id=?').run(agentId, req.params.id);
      }
      await db.prepare('UPDATE agents SET workspace_id=(SELECT workspace_id FROM workspace_members WHERE user_id=? AND workspace_id<>? ORDER BY workspace_id LIMIT 1) WHERE user_id=? AND workspace_id=?').run(req.params.userId, req.params.id, req.params.userId, req.params.id);
      await db.prepare("UPDATE report_jobs SET status='failed',error='workspace membership removed',completed_at=? WHERE workspace_id=? AND user_id=? AND status IN ('pending','running')").run(now(), req.params.id, req.params.userId);
      await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(req.params.id, req.params.userId);
      return 'deleted';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'Manager required'});
    if (outcome === 'missing') return res.status(404).json({error: 'member not found'});
    if (outcome === 'last-manager') return res.status(409).json({error: 'workspace must retain a Manager'});
    res.status(204).end();
  });
  app.post('/api/workspaces/:id/invite/regenerate', userAuth, requireManager, async (req: Authed, res) => {
    const refreshedAt = now();
    const cooldownCutoff = new Date(Date.now() - 60_000).toISOString();
    let inviteCode = '';
    let updated: {changes: number} | undefined;
    for (let attempt = 0; attempt < 3 && !updated; attempt++) {
      inviteCode = await freshInviteCode();
      try {
        updated = await db.prepare("UPDATE workspaces SET invite_code=?,invite_enabled=TRUE,invite_refreshed_at=? WHERE id=? AND (invite_refreshed_at IS NULL OR invite_refreshed_at<=?) AND id IN (SELECT workspace_id FROM workspace_members WHERE workspace_id=? AND user_id=? AND role='Manager')").run(inviteCode, refreshedAt, req.params.id, cooldownCutoff, req.params.id, req.user.id);
      } catch (error: any) {
        if (!inviteCodeCollision(error) || attempt === 2) throw error;
      }
    }
    if (!updated) throw new Error('could not allocate workspace invite code');
    if (!updated.changes) {
      if (!(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return res.status(403).json({error: 'Manager required'});
      const workspace: any = await db.prepare('SELECT invite_refreshed_at FROM workspaces WHERE id=?').get(req.params.id);
      const retryAfter = Math.max(1, Math.ceil((new Date(workspace.invite_refreshed_at).getTime() + 60_000 - Date.now()) / 1000));
      return res.status(429).set('retry-after', String(retryAfter)).json({error: 'Invite code can only be refreshed once per minute.', retryAfter});
    }
    res.json({inviteCode, refreshedAt});
  });
  app.post('/api/workspaces/:id/invite/disable', userAuth, requireManager, async (req: Authed, res) => {
    const updated = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return false;
      await db.prepare('UPDATE workspaces SET invite_enabled=FALSE WHERE id=?').run(req.params.id);
      return true;
    });
    if (!updated) return res.status(403).json({error: 'Manager required'});
    res.json({ok: true});
  });
  app.delete('/api/workspaces/:id', userAuth, requireManager, async (req: Authed, res) => {
    const deleted = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await hasLockedManagerAuthority(+req.params.id, req.user.id))) return false;
      await db.prepare('DELETE FROM pending_pushes WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      await db.prepare('DELETE FROM activity_events WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      await db.prepare('DELETE FROM local_clones WHERE repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.params.id);
      await db.prepare('DELETE FROM reports WHERE workspace_id=?').run(req.params.id);
      await db.prepare('DELETE FROM report_jobs WHERE workspace_id=?').run(req.params.id);
      await db.prepare('DELETE FROM repositories WHERE workspace_id=?').run(req.params.id);
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(req.params.id);
      return true;
    });
    if (!deleted) return res.status(403).json({error: 'Manager required'});
    res.status(204).end();
  });

  app.post('/api/agents/installations', userAuth, async (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (!(await membership(req.user.id, workspaceId))) return res.status(403).json({error: 'forbidden'});
    const raw = token();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await db.prepare('INSERT INTO setup_codes(code_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)').run(hash(raw), req.user.id, workspaceId, expiresAt, now());
    const origin = requestOrigin(req);
    res.status(201).json({installCommand: linuxInstallCommand(origin, raw), syncCommand: linuxSyncCommand(origin, raw), expiresAt});
  });
  app.get('/api/installers/linux/:installToken', async (req, res) => {
    const setup: any = await db.prepare('SELECT * FROM setup_codes WHERE code_hash=?').get(hash(req.params.installToken));
    if (!setup || setup.used_at || expired(setup.expires_at)) return res.status(410).type('text/plain').send('Install token invalid, expired, or already used.\n');
    try {
      res.type('text/x-shellscript').set('content-disposition', 'attachment; filename="tracemini-install.sh"').send(linuxInstaller(cliDir, requestOrigin(req), req.params.installToken));
    } catch (error: any) {
      res.status(503).json({error: error.message});
    }
  });
  app.post('/api/agents/install/exchange', required(['installToken', 'machineName']), async (req, res) => {
    const installationId = req.body.installationId == null ? null : String(req.body.installationId);
    if (installationId && !/^[a-f0-9]{64}$/.test(installationId)) return res.status(400).json({error: 'invalid installation identity'});
    const agentToken = token();
    const previousAgentToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const candidate: any = await db.prepare('SELECT workspace_id FROM setup_codes WHERE code_hash=?').get(hash(req.body.installToken));
    if (!candidate) return res.status(409).json({error: 'install token invalid, expired, or already used'});
    const exchanged = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(candidate.workspace_id);
      if (!workspace) return undefined;
      const setup: any = await db.prepare('SELECT * FROM setup_codes WHERE code_hash=? FOR UPDATE').get(hash(req.body.installToken));
      if (!setup || setup.workspace_id !== candidate.workspace_id || setup.used_at || expired(setup.expires_at)) return undefined;
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(setup.workspace_id, setup.user_id);
      if (!member) return undefined;
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(setup.user_id);
      await db.prepare('UPDATE setup_codes SET used_at=? WHERE code_hash=?').run(now(), setup.code_hash);
      let previous: any;
      if (previousAgentToken) previous = await db.prepare('SELECT id,user_id FROM agents WHERE token_hash=? AND revoked_at IS NULL AND removed_at IS NULL FOR UPDATE').get(hash(previousAgentToken));
      if (previous && previous.user_id !== setup.user_id) {
        await revokeDeviceWork(previous.id, 'device synced to another account');
        previous = undefined;
      }
      let reusable: any = installationId ? await db.prepare('SELECT id,user_id FROM agents WHERE user_id=? AND installation_id=? AND revoked_at IS NULL AND removed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE').get(setup.user_id, installationId) : undefined;
      if (reusable && previous && previous.id !== reusable.id) {
        await revokeDeviceWork(reusable.id, 'duplicate installation consolidated');
        await db.prepare('DELETE FROM local_clones WHERE agent_id=?').run(reusable.id);
        await db.prepare('DELETE FROM repository_candidates WHERE agent_id=?').run(reusable.id);
        await db.prepare('UPDATE agents SET removed_at=? WHERE id=?').run(now(), reusable.id);
        reusable = previous;
      }
      if (!reusable && previous?.user_id === setup.user_id) reusable = previous;
      if (reusable) {
        await db.prepare('UPDATE agents SET workspace_id=?,machine_name=?,installation_id=COALESCE(?,installation_id),token_hash=?,last_seen=? WHERE id=?').run(setup.workspace_id, req.body.machineName.trim(), installationId, hash(agentToken), now(), reusable.id);
        return {agentId: Number(reusable.id), workspaceId: setup.workspace_id};
      }
      const result = installationId
        ? await db.prepare('INSERT INTO agents(user_id,workspace_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (user_id,installation_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,machine_name=EXCLUDED.machine_name,token_hash=EXCLUDED.token_hash,last_seen=EXCLUDED.last_seen RETURNING id').run(setup.user_id, setup.workspace_id, req.body.machineName.trim(), installationId, hash(agentToken), now(), now())
        : await db.prepare('INSERT INTO agents(user_id,workspace_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id').run(setup.user_id, setup.workspace_id, req.body.machineName.trim(), installationId, hash(agentToken), now(), now());
      return {agentId: Number(result.lastInsertRowid), workspaceId: setup.workspace_id};
    });
    if (!exchanged) return res.status(409).json({error: 'install token invalid, expired, or already used'});
    res.status(201).json({...exchanged, agentToken});
  });
  app.post('/api/agents/register', userAuth, required(['machineName']), async (req: Authed, res) => {
    const installationId = req.body.installationId == null ? null : String(req.body.installationId);
    if (installationId && !/^[a-f0-9]{64}$/.test(installationId)) return res.status(400).json({error: 'invalid installation identity'});
    const raw = token();
    const agentId = await db.transaction(async () => {
      await db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(req.user.id);
      const existing: any = installationId ? await db.prepare('SELECT id FROM agents WHERE user_id=? AND installation_id=? AND revoked_at IS NULL AND removed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE').get(req.user.id, installationId) : undefined;
      if (existing) {
        await db.prepare('UPDATE agents SET machine_name=?,token_hash=?,last_seen=? WHERE id=?').run(req.body.machineName, hash(raw), now(), existing.id);
        return Number(existing.id);
      }
      const result = installationId
        ? await db.prepare('INSERT INTO agents(user_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT (user_id,installation_id) DO UPDATE SET machine_name=EXCLUDED.machine_name,token_hash=EXCLUDED.token_hash,last_seen=EXCLUDED.last_seen RETURNING id').run(req.user.id, req.body.machineName, installationId, hash(raw), now(), now())
        : await db.prepare('INSERT INTO agents(user_id,machine_name,installation_id,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?) RETURNING id').run(req.user.id, req.body.machineName, installationId, hash(raw), now(), now());
      return Number(result.lastInsertRowid);
    });
    res.status(201).json({agentId, token: raw});
  });
  app.post('/api/agents/workspace', agentAuth, required(['workspaceId']), async (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    const outcome = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, req.agent.user_id))) return 'forbidden';
      const agent: any = await db.prepare('SELECT * FROM agents WHERE id=? FOR UPDATE').get(req.agent.id);
      if (!agent || agent.revoked_at) return 'forbidden';
      await db.prepare('UPDATE agents SET workspace_id=? WHERE id=?').run(workspaceId, agent.id);
      return 'updated';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'forbidden'});
    res.json({ok: true, workspaceId});
  });
  app.get('/api/agents/status', agentAuth, async (req: Authed, res) => res.json(await agentStatus(req.agent)));
  app.post('/api/agents/heartbeat', agentAuth, async (req: Authed, res) => res.json({ok: true, at: now(), workspaceIds: await agentWorkspaceIds(req.agent.user_id)}));
  app.post('/api/agents/repository-candidates', agentAuth, async (req: Authed, res) => {
    const repositories = req.body?.repositories;
    if (!Array.isArray(repositories) || repositories.length > 500) return res.status(400).json({error: 'repositories array required (maximum 500)'});
    const workspaceId = Number(req.body.workspaceId || req.agent.workspace_id);
    if (!Number.isInteger(workspaceId) || !(await membership(req.agent.user_id, workspaceId))) return res.status(403).json({error: 'workspace unavailable'});
    for (const candidate of repositories) {
      if (!candidate || typeof candidate.localKey !== 'string' || !candidate.localKey.startsWith('/') || candidate.localKey.length > 4096 || typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 200 || typeof candidate.remoteUrl !== 'string' || candidate.remoteUrl.length > 4096 || typeof candidate.traced !== 'boolean' || (candidate.branch != null && (typeof candidate.branch !== 'string' || candidate.branch.length > 500)) || (candidate.repositoryId != null && !Number.isInteger(Number(candidate.repositoryId))) || (candidate.identityFingerprint != null && (typeof candidate.identityFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.identityFingerprint))) || (candidate.identityChanged != null && typeof candidate.identityChanged !== 'boolean')) {
        return res.status(400).json({error: 'invalid repository candidate'});
      }
    }
    try {
      await db.transaction(async () => {
        await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
        if (!(await membership(req.agent.user_id, workspaceId))) throw Object.assign(new Error('workspace unavailable'), {status: 403});
        for (const candidate of repositories) {
        const normalized = normalizeRemote(candidate.remoteUrl) || `local/${req.agent.id}/${candidate.name}`;
        const existing: any = await db.prepare('SELECT * FROM repository_candidates WHERE agent_id=? AND workspace_id=? AND local_key=? FOR UPDATE').get(req.agent.id, workspaceId, candidate.localKey);
        const incomingFingerprint = candidate.identityFingerprint || null;
        const identityChanged = candidate.identityChanged === true || Boolean(existing?.repository_fingerprint && existing.repository_fingerprint !== incomingFingerprint);
        if (existing && identityChanged) {
          await db.prepare(`UPDATE repository_candidates SET name=?,remote_url=?,normalized_remote=?,branch=?,traced=FALSE,desired_traced=FALSE,last_seen=?,error='repository identity changed; select again to resume',repository_id=NULL,repository_fingerprint=?,revision=revision+1 WHERE id=?`).run(candidate.name.trim(), candidate.remoteUrl, normalized, candidate.branch || null, now(), incomingFingerprint, existing.id);
          await db.prepare('DELETE FROM local_clones WHERE agent_id=? AND local_key=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?)').run(req.agent.id, candidate.localKey, workspaceId);
          await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND local_key=? AND repository_id IN (SELECT id FROM repositories WHERE workspace_id=?) AND status='pending'").run(now(), req.agent.id, candidate.localKey, workspaceId);
          continue;
        }
        const clone: any = candidate.repositoryId == null ? undefined : await db.prepare(`SELECT lc.repository_id FROM local_clones lc JOIN repositories r ON r.id=lc.repository_id WHERE lc.agent_id=? AND lc.local_key=? AND lc.repository_id=? AND r.workspace_id=?`).get(req.agent.id, candidate.localKey, Number(candidate.repositoryId), workspaceId);
        const traced = Boolean(candidate.traced);
        const desiredTraced = Boolean(candidate.traced && clone?.repository_id);
        await db.prepare(`INSERT INTO repository_candidates(agent_id,workspace_id,local_key,name,remote_url,normalized_remote,branch,traced,desired_traced,last_seen,error,repository_id,repository_fingerprint)
          VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)
          ON CONFLICT(agent_id,workspace_id,local_key) DO UPDATE SET name=excluded.name,remote_url=excluded.remote_url,normalized_remote=excluded.normalized_remote,branch=excluded.branch,traced=excluded.traced,last_seen=excluded.last_seen,error=NULL,repository_id=COALESCE(excluded.repository_id,repository_candidates.repository_id),repository_fingerprint=COALESCE(excluded.repository_fingerprint,repository_candidates.repository_fingerprint)`).run(
          req.agent.id, workspaceId, candidate.localKey, candidate.name.trim(), candidate.remoteUrl, normalized, candidate.branch || null, traced, desiredTraced, now(), clone?.repository_id || null, incomingFingerprint,
        );
        }
      });
    } catch (error: any) {
      if (error?.status === 403 || error?.status === 409) return res.status(error.status).json({error: error.message});
      throw error;
    }
    res.json({ok: true, count: repositories.length});
  });
  app.get('/api/workspaces/:id/repository-candidates', userAuth, requireMember, async (req: Authed, res) => {
    const rows = await db.prepare(`SELECT c.id,c.local_key,c.name,c.normalized_remote,c.branch,c.traced,c.desired_traced,c.revision,c.last_seen,c.error,c.repository_id,a.id agent_id,a.machine_name
      FROM repository_candidates c JOIN agents a ON a.id=c.agent_id JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=?
      WHERE c.workspace_id=? AND a.user_id=? AND a.revoked_at IS NULL ORDER BY a.machine_name,c.name,c.local_key`).all(req.user.id, req.params.id, req.user.id);
    res.json(rows);
  });
  app.patch('/api/workspaces/:id/repository-candidates/:candidateId', userAuth, requireMember, async (req: Authed, res) => {
    if (typeof req.body.traced !== 'boolean') return res.status(400).json({error: 'traced boolean required'});
    const revision = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace) return undefined;
      const candidate: any = await db.prepare(`SELECT c.* FROM repository_candidates c JOIN agents a ON a.id=c.agent_id JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=? WHERE c.id=? AND c.workspace_id=? AND a.user_id=? AND a.revoked_at IS NULL FOR UPDATE`).get(req.user.id, req.params.candidateId, req.params.id, req.user.id);
      if (!candidate) return undefined;
      const nextRevision = Number(candidate.revision) + 1;
      await db.prepare('UPDATE repository_candidates SET desired_traced=?,revision=?,error=NULL WHERE id=?').run(req.body.traced, nextRevision, candidate.id);
      if (!req.body.traced && candidate.repository_id) await db.prepare("UPDATE pending_pushes SET status='unconfirmed',completed_at=? WHERE agent_id=? AND repository_id=? AND local_key=? AND status='pending'").run(now(), candidate.agent_id, candidate.repository_id, candidate.local_key);
      return nextRevision;
    });
    if (revision == null) return res.status(404).json({error: 'repository candidate not found'});
    res.json({ok: true, revision});
  });
  app.get('/api/agents/repository-selections', agentAuth, async (req: Authed, res) => {
    const rows = await db.prepare('SELECT c.id,c.workspace_id,c.local_key,c.name,c.remote_url,c.normalized_remote,c.branch,c.traced,c.desired_traced,c.revision,c.repository_fingerprint FROM repository_candidates c JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=? WHERE c.agent_id=? AND c.desired_traced<>c.traced ORDER BY c.id').all(req.agent.user_id, req.agent.id);
    res.json(rows);
  });
  app.post('/api/agents/repository-selections/:candidateId/claim', agentAuth, async (req: Authed, res) => {
    const revision = Number(req.body.revision);
    if (!Number.isInteger(revision) || typeof req.body.desiredTraced !== 'boolean') return res.status(400).json({error: 'revision and desiredTraced required'});
    const candidate = await db.prepare('SELECT 1 FROM repository_candidates c JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=? WHERE c.id=? AND c.agent_id=? AND c.revision=? AND c.desired_traced=?').get(req.agent.user_id, req.params.candidateId, req.agent.id, revision, req.body.desiredTraced);
    if (!candidate) return res.status(409).json({error: 'repository selection changed'});
    res.json({ok: true});
  });
  app.post('/api/agents/repository-selections/:candidateId/complete', agentAuth, async (req: Authed, res) => {
    const revision = Number(req.body.revision);
    if (typeof req.body.traced !== 'boolean' || typeof req.body.desiredTraced !== 'boolean' || !Number.isInteger(revision)) return res.status(400).json({error: 'traced, desiredTraced, and revision required'});
    const updated = await db.prepare('UPDATE repository_candidates SET traced=?,last_seen=?,error=? WHERE id=? AND agent_id=? AND revision=? AND desired_traced=? AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)').run(req.body.traced, now(), req.body.error ? String(req.body.error).slice(0, 2000) : null, req.params.candidateId, req.agent.id, revision, req.body.desiredTraced, req.agent.user_id);
    if (!updated.changes && req.body.traced === false) await db.prepare('UPDATE repository_candidates SET traced=FALSE,last_seen=? WHERE id=? AND agent_id=? AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)').run(now(), req.params.candidateId, req.agent.id, req.agent.user_id);
    if (!updated.changes) return res.status(409).json({error: 'repository selection changed'});
    res.json({ok: true});
  });
  app.get('/api/workspaces/:id/agents', userAuth, requireMember, async (req, res) => {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const rows = await db.prepare("SELECT a.id,a.user_id,a.machine_name,a.last_seen,a.revoked_at,u.name user_name,CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' WHEN a.last_seen>=? THEN 'online' ELSE 'offline' END status FROM agents a JOIN users u ON u.id=a.user_id JOIN workspace_members wm ON wm.user_id=a.user_id AND wm.workspace_id=? WHERE a.removed_at IS NULL ORDER BY a.id").all(cutoff, req.params.id);
    res.json(rows);
  });
  app.post('/api/workspaces/:id/agents/:agentId/revoke', userAuth, requireMember, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.user.id))) return 'forbidden';
      const agent: any = await db.prepare('SELECT id FROM agents WHERE id=? AND user_id=? FOR UPDATE').get(req.params.agentId, req.user.id);
      if (!agent) return 'missing';
      await revokeDeviceWork(agent.id);
      return 'revoked';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'membership required'});
    if (outcome === 'missing') return res.status(404).json({error: 'device not found'});
    res.json({ok: true});
  });
  app.delete('/api/workspaces/:id/agents/:agentId', userAuth, requireMember, async (req: Authed, res) => {
    const outcome = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(req.params.id);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(req.params.id, req.user.id))) return 'forbidden';
      const agent: any = await db.prepare('SELECT id,revoked_at,removed_at FROM agents WHERE id=? AND user_id=? FOR UPDATE').get(req.params.agentId, req.user.id);
      if (!agent || agent.removed_at) return 'missing';
      if (!agent.revoked_at) return 'active';
      await db.prepare('UPDATE agents SET removed_at=? WHERE id=? AND removed_at IS NULL').run(now(), agent.id);
      return 'removed';
    });
    if (outcome === 'forbidden') return res.status(403).json({error: 'membership required'});
    if (outcome === 'missing') return res.status(404).json({error: 'device not found'});
    if (outcome === 'active') return res.status(409).json({error: 'revoke the device before removing it'});
    res.status(204).end();
  });

  app.post('/api/repositories/register', agentAuth, required(['workspaceId', 'name', 'remoteUrl', 'localKey']), async (req: Authed, res) => {
    const workspaceId = Number(req.body.workspaceId);
    if (!(await membership(req.agent.user_id, workspaceId))) return res.status(403).json({error: 'workspace unavailable'});
    const normalized = normalizeRemote(req.body.remoteUrl);
    if (!normalized) return res.status(400).json({error: 'remote URL required'});
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(409).json({error: 'repository fingerprint required'});
    const repository: any = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
      if (!workspace) return undefined;
      const agent: any = await db.prepare('SELECT * FROM agents WHERE id=? FOR UPDATE').get(req.agent.id);
      if (!agent || agent.revoked_at || !(await membership(agent.user_id, workspaceId))) return undefined;
      const candidate: any = await db.prepare(`SELECT c.id FROM repository_candidates c JOIN agents a ON a.id=c.agent_id JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id
        WHERE c.agent_id=? AND c.workspace_id=? AND c.local_key=? AND c.desired_traced=TRUE AND c.repository_fingerprint=? AND a.revoked_at IS NULL FOR UPDATE`).get(req.agent.id, workspaceId, req.body.localKey, fingerprint);
      if (!candidate) return undefined;
      await db.prepare('INSERT INTO repositories(workspace_id,name,remote_url,normalized_remote,created_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,normalized_remote) DO UPDATE SET name=excluded.name,remote_url=excluded.remote_url').run(workspaceId, req.body.name, req.body.remoteUrl, normalized, now());
      const selected: any = await db.prepare('SELECT * FROM repositories WHERE workspace_id=? AND normalized_remote=?').get(workspaceId, normalized);
      await db.prepare('INSERT INTO local_clones(agent_id,repository_id,local_key,branch,last_seen,head_sha,remote_head_sha) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,repository_id,local_key) DO UPDATE SET branch=excluded.branch,last_seen=excluded.last_seen,head_sha=excluded.head_sha,remote_head_sha=excluded.remote_head_sha').run(req.agent.id, selected.id, req.body.localKey, req.body.branch || null, now(), req.body.headSha || null, req.body.remoteHeadSha || null);
      await db.prepare('UPDATE repository_candidates SET workspace_id=?,repository_id=?,repository_fingerprint=?,last_seen=?,error=NULL WHERE id=?').run(workspaceId, selected.id, fingerprint, now(), candidate.id);
      return selected;
    });
    if (!repository) return res.status(409).json({error: 'repository must be selected before registration'});
    res.json(repository);
  });
  app.get('/api/workspaces/:id/repositories', userAuth, requireMember, async (req, res) => {
    const archived = req.query.includeArchived === 'true' ? '' : ' AND r.archived=FALSE';
    const rows = await db.prepare(`SELECT r.* FROM repositories r WHERE r.workspace_id=?${archived} ORDER BY r.name`).all(req.params.id);
    const result = await Promise.all(rows.map(async (row: any) => ({...row, archived: row.archived ? 1 : 0, clone_count: (await db.prepare('SELECT COUNT(*)::INTEGER count FROM local_clones WHERE repository_id=?').get(row.id)).count})));
    res.json(result);
  });
  app.patch('/api/workspaces/:id/repositories/:repositoryId', userAuth, requireManager, async (req, res) => {
    if (typeof req.body.archived !== 'boolean') return res.status(400).json({error: 'archived boolean required'});
    const result = await db.prepare('UPDATE repositories SET archived=? WHERE id=? AND workspace_id=?').run(req.body.archived, req.params.repositoryId, req.params.id);
    if (!result.changes) return res.status(404).json({error: 'repository not found'});
    res.json({ok: true});
  });

  app.post('/api/pushes/pending', agentAuth, required(['eventKey', 'localKey', 'remoteName', 'remoteUrl', 'ref', 'expectedSha', 'occurredAt']), async (req: Authed, res) => {
    const occurredAt = instant(req.body.occurredAt);
    if (!occurredAt) return res.status(400).json({error: 'occurredAt must be an ISO timestamp'});
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(403).json({error: 'repository fingerprint required'});
    const outcome = await db.transaction(async () => {
      const repository: any = await db.prepare('SELECT r.* FROM repositories r JOIN repository_candidates c ON c.repository_id=r.id AND c.agent_id=? AND c.local_key=? AND c.desired_traced=TRUE AND c.repository_fingerprint=? JOIN agents a ON a.id=c.agent_id AND a.revoked_at IS NULL JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id WHERE r.id=? FOR UPDATE').get(req.agent.id, req.body.localKey, fingerprint, req.body.repositoryId);
      if (!repository) return undefined;
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(repository.workspace_id);
      if (!(await membership(req.agent.user_id, repository.workspace_id))) return undefined;
      const result = await db.prepare("INSERT INTO pending_pushes(event_key,user_id,agent_id,repository_id,local_key,repository_fingerprint,remote_name,remote_url,ref,expected_sha,status,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?) ON CONFLICT DO NOTHING").run(req.body.eventKey, req.agent.user_id, req.agent.id, repository.id, req.body.localKey, fingerprint, req.body.remoteName, req.body.remoteUrl, req.body.ref, req.body.expectedSha, occurredAt);
      const push = await db.prepare('SELECT * FROM pending_pushes WHERE event_key=?').get(req.body.eventKey);
      return {created: Boolean(result.changes), push};
    });
    if (!outcome) return res.status(403).json({error: 'repository not available'});
    res.status(outcome.created ? 201 : 200).json(outcome.push);
  });
  app.get('/api/agents/pushes', agentAuth, async (req: Authed, res) => res.json(await db.prepare("SELECT * FROM pending_pushes WHERE agent_id=? AND status='pending' AND (next_check_at IS NULL OR next_check_at<=?) ORDER BY id LIMIT 10").all(req.agent.id, now())));
  app.post('/api/agents/pushes/:pushId/complete', agentAuth, async (req: Authed, res) => {
    if (!['confirmed', 'unconfirmed'].includes(req.body.status)) return res.status(400).json({error: 'invalid status'});
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(409).json({error: 'repository fingerprint required'});
    const outcome = await db.transaction(async () => {
      const push: any = await db.prepare("SELECT p.*,r.workspace_id FROM pending_pushes p JOIN repositories r ON r.id=p.repository_id WHERE p.id=? AND p.agent_id=? AND p.status='pending' FOR UPDATE").get(req.params.pushId, req.agent.id);
      if (!push) return {kind: 'unavailable'} as const;
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(push.workspace_id);
      if (!(await membership(req.agent.user_id, push.workspace_id))) return {kind: 'unavailable'} as const;
      if (push.repository_fingerprint !== fingerprint) return {kind: 'unavailable'} as const;
      const active = await db.prepare('SELECT 1 FROM repository_candidates c JOIN agents a ON a.id=c.agent_id AND a.revoked_at IS NULL JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id WHERE c.agent_id=? AND c.workspace_id=? AND c.repository_id=? AND c.local_key=? AND c.repository_fingerprint=? AND c.desired_traced=TRUE').get(push.agent_id, push.workspace_id, push.repository_id, push.local_key, fingerprint);
      if (!active) return {kind: 'unavailable'} as const;
      if (req.body.status === 'unconfirmed' && push.attempts < 2) {
        const nextCheckAt = new Date(Date.now() + 10_000).toISOString();
        await db.prepare("UPDATE pending_pushes SET attempts=attempts+1,next_check_at=? WHERE id=? AND status='pending'").run(nextCheckAt, push.id);
        return {kind: 'retrying', nextCheckAt} as const;
      }
      const observedSha = req.body.observedSha || null;
      await db.prepare("UPDATE pending_pushes SET status=?,observed_sha=?,completed_at=? WHERE id=? AND status='pending'").run(req.body.status, observedSha, now(), push.id);
      await db.prepare('INSERT INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(push.event_key, push.user_id, push.agent_id, push.repository_id, 'push', push.occurred_at, JSON.stringify({remote: push.remote_name, remoteUrl: push.remote_url, ref: push.ref, expectedSha: push.expected_sha, observedSha, confirmation: req.body.status}), now());
      return {kind: 'completed'} as const;
    });
    if (outcome.kind === 'unavailable') return res.status(409).json({error: 'push unavailable'});
    if (outcome.kind === 'retrying') return res.json({ok: true, retrying: true, nextCheckAt: outcome.nextCheckAt});
    res.json({ok: true});
  });

  app.post('/api/activity', agentAuth, required(['eventKey', 'localKey', 'type', 'occurredAt']), async (req: Authed, res) => {
    const occurredAt = instant(req.body.occurredAt);
    if (!occurredAt) return res.status(400).json({error: 'occurredAt must be an ISO timestamp'});
    const repositoryId = Number(req.body.repositoryId);
    const fingerprint = typeof req.body.identityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(req.body.identityFingerprint) ? req.body.identityFingerprint : null;
    if (!fingerprint) return res.status(403).json({error: 'repository fingerprint required'});
    const accepted = await db.transaction(async () => {
      const repository: any = await db.prepare('SELECT r.* FROM repositories r JOIN repository_candidates c ON c.repository_id=r.id AND c.agent_id=? AND c.local_key=? AND c.desired_traced=TRUE AND c.repository_fingerprint=? JOIN agents a ON a.id=c.agent_id AND a.revoked_at IS NULL JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=a.user_id WHERE r.id=? FOR UPDATE').get(req.agent.id, req.body.localKey, fingerprint, repositoryId);
      if (!repository) return undefined;
      await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(repository.workspace_id);
      if (!(await membership(req.agent.user_id, repository.workspace_id))) return undefined;
      const result = await db.prepare('INSERT INTO activity_events(event_key,user_id,agent_id,repository_id,type,occurred_at,data,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(req.body.eventKey, req.agent.user_id, req.agent.id, repository.id, req.body.type, occurredAt, JSON.stringify(req.body.data || {}), now());
      return Boolean(result.changes);
    });
    if (accepted == null) return res.status(403).json({error: 'repository not available'});
    res.status(accepted ? 201 : 200).json({accepted});
  });
  const queryActivity = async (req: Authed, res: Response, extra: string, args: any[]) => {
    const workspaceId = Number(req.params.workspaceId || req.query.workspaceId || 0);
    if (!workspaceId || !(await membership(req.user.id, workspaceId))) return res.status(403).json({error: 'forbidden'});
    let sql = 'SELECT e.*,u.name user_name,r.name repository_name FROM activity_events e JOIN users u ON u.id=e.user_id JOIN repositories r ON r.id=e.repository_id WHERE r.workspace_id=?' + extra;
    const values: any[] = [workspaceId, ...args];
    const timezone = normalizeTimezone(req.query.timezone);
    if (req.query.from) { sql += ' AND e.occurred_at>=?'; values.push(dateRangeUtc(String(req.query.from), String(req.query.from), timezone).from); }
    if (req.query.to) { sql += ' AND e.occurred_at<=?'; values.push(dateRangeUtc(String(req.query.to), String(req.query.to), timezone).to); }
    sql += ' ORDER BY e.occurred_at DESC LIMIT 500';
    res.json((await db.prepare(sql).all(...values)).map((row: any) => ({...row, data: eventData(row.data)})));
  };
  app.get('/api/workspaces/:workspaceId/activity', userAuth, async (req: Authed, res) => await queryActivity(req, res, '', []));
  app.get('/api/repositories/:id/activity', userAuth, async (req: Authed, res) => await queryActivity(req, res, ' AND e.repository_id=?', [+req.params.id]));
  app.get('/api/users/:id/activity', userAuth, async (req: Authed, res) => await queryActivity(req, res, ' AND e.user_id=?', [+req.params.id]));
  app.get('/api/workspaces/:id/stats', userAuth, requireMember, async (req, res) => {
    const timezone = normalizeTimezone(req.query.timezone);
    const filters: string[] = ["r.workspace_id=?", "e.type='commit'"];
    const values: any[] = [req.params.id];
    if (req.query.userId) { filters.push('e.user_id=?'); values.push(req.query.userId); }
    if (req.query.repositoryId) { filters.push('e.repository_id=?'); values.push(req.query.repositoryId); }
    if (req.query.from) { filters.push('e.occurred_at>=?'); values.push(dateRangeUtc(String(req.query.from), String(req.query.from), timezone).from); }
    if (req.query.to) { filters.push('e.occurred_at<=?'); values.push(dateRangeUtc(String(req.query.to), String(req.query.to), timezone).to); }
    const where = filters.join(' AND ');
    const totals: any = await db.prepare(`SELECT COUNT(*)::INTEGER commits,COALESCE(SUM(CAST(e.data::JSONB->>'filesChanged' AS INTEGER)),0)::INTEGER "filesChanged",COALESCE(SUM(CAST(e.data::JSONB->>'insertions' AS INTEGER)),0)::INTEGER insertions,COALESCE(SUM(CAST(e.data::JSONB->>'deletions' AS INTEGER)),0)::INTEGER deletions FROM activity_events e JOIN repositories r ON r.id=e.repository_id WHERE ${where}`).get(...values);
    const dailyEvents = await db.prepare(`SELECT e.occurred_at,e.data FROM activity_events e JOIN repositories r ON r.id=e.repository_id WHERE ${where} ORDER BY e.occurred_at`).all(...values);
    const dailyByDate = new Map<string, any>();
    for (const event of dailyEvents) {
      const date = dateKeyInTimezone(event.occurred_at, timezone);
      const data: any = eventData(event.data) || {};
      const current = dailyByDate.get(date) || {date, commits: 0, filesChanged: 0, insertions: 0, deletions: 0};
      current.commits += 1;
      current.filesChanged += Number(data.filesChanged || 0);
      current.insertions += Number(data.insertions || 0);
      current.deletions += Number(data.deletions || 0);
      dailyByDate.set(date, current);
    }
    const daily = [...dailyByDate.values()];
    res.json({totals, daily});
  });

  app.post('/api/reports/jobs', userAuth, required(['workspaceId', 'startDate', 'endDate', 'reporter']), async (req: Authed, res) => {
    if (!['codex', 'hermes'].includes(req.body.reporter)) return res.status(400).json({error: 'invalid reporter'});
    if (!dateOnly(req.body.startDate) || !dateOnly(req.body.endDate) || req.body.startDate > req.body.endDate) return res.status(400).json({error: 'invalid report date range'});
    if (req.body.name !== undefined && typeof req.body.name !== 'string') return res.status(400).json({error: 'invalid report name'});
    const reportName = req.body.name?.trim() || defaultReportName(req.body.startDate, req.body.endDate);
    if (reportName.length > 120) return res.status(400).json({error: 'report name must be 120 characters or fewer'});
    const outcome = await db.transaction(async () => {
      const workspaceId = +req.body.workspaceId;
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(workspaceId);
      if (!workspace || !(await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, req.user.id))) return undefined;
      const active: any = await db.prepare("SELECT * FROM report_jobs WHERE workspace_id=? AND user_id=? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1 FOR UPDATE").get(workspaceId, req.user.id);
      if (active) return {job: active, created: false};
      const timezone = normalizeTimezone(req.body.timezone);
      const includeDiff = req.body.includeDiff === true;
      const result = await db.prepare("INSERT INTO report_jobs(workspace_id,user_id,reporter,start_date,end_date,timezone,include_diff,status,report_name,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?) RETURNING id").run(workspaceId, req.user.id, req.body.reporter, req.body.startDate, req.body.endDate, timezone, includeDiff, reportName, now());
      return {job: {id: Number(result.lastInsertRowid), status: 'pending'}, created: true};
    });
    if (!outcome) return res.status(403).json({error: 'forbidden'});
    res.status(outcome.created ? 201 : 200).json(outcome.job);
  });
  app.get('/api/workspaces/:id/report-jobs/active', userAuth, requireMember, async (req: Authed, res) => {
    const row = await db.prepare("SELECT * FROM report_jobs WHERE workspace_id=? AND user_id=? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1").get(req.params.id, req.user.id);
    res.json(row || null);
  });
  app.post('/api/reports/:id/regenerate', userAuth, required(['reporter', 'prompt']), async (req: Authed, res) => {
    if (!['codex', 'hermes'].includes(req.body.reporter)) return res.status(400).json({error: 'invalid reporter'});
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) return res.status(400).json({error: 'prompt must be between 1 and 4000 characters'});
    const scope: any = await db.prepare('SELECT workspace_id FROM reports WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!scope) return res.status(404).json({error: 'not found'});
    const result = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      if (!workspace) return {status: 'not_found'};
      const report: any = await db.prepare('SELECT * FROM reports WHERE id=? AND user_id=? AND workspace_id=? FOR UPDATE').get(req.params.id, req.user.id, scope.workspace_id);
      if (!report) return {status: 'not_found'};
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(report.workspace_id, req.user.id);
      if (!member) return {status: 'forbidden'};
      const active = await db.prepare("SELECT id FROM report_jobs WHERE target_report_id=? AND status IN ('pending','running')").get(report.id);
      if (active) return {status: 'conflict'};
      const inserted = await db.prepare("INSERT INTO report_jobs(workspace_id,user_id,reporter,start_date,end_date,timezone,include_diff,status,custom_prompt,target_report_id,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?) RETURNING id").run(report.workspace_id, report.user_id, req.body.reporter, report.start_date, report.end_date, normalizeTimezone(report.timezone), Boolean(report.include_diff), prompt, report.id, now());
      return {status: 'created', id: Number(inserted.lastInsertRowid)};
    });
    if (result.status === 'not_found') return res.status(404).json({error: 'not found'});
    if (result.status === 'forbidden') return res.status(403).json({error: 'forbidden'});
    if (result.status === 'conflict') return res.status(409).json({error: 'report regeneration already queued'});
    res.status(201).json({id: result.id, status: 'pending'});
  });
  app.patch('/api/reports/:id', userAuth, required(['name']), async (req: Authed, res) => {
    const name = req.body.name.trim();
    if (name.length > 120) return res.status(400).json({error: 'report name must be 120 characters or fewer'});
    const scope: any = await db.prepare('SELECT workspace_id FROM reports WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!scope) return res.status(404).json({error: 'not found'});
    const result = await db.transaction(async () => {
      const workspace = await db.prepare('SELECT id FROM workspaces WHERE id=? FOR UPDATE').get(scope.workspace_id);
      if (!workspace) return {status: 'not_found'};
      const report: any = await db.prepare('SELECT id,workspace_id FROM reports WHERE id=? AND user_id=? AND workspace_id=? FOR UPDATE').get(req.params.id, req.user.id, scope.workspace_id);
      if (!report) return {status: 'not_found'};
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(report.workspace_id, req.user.id);
      if (!member) return {status: 'forbidden'};
      return {status: 'updated', report: await db.prepare('UPDATE reports SET name=? WHERE id=? RETURNING *').get(name, report.id)};
    });
    if (result.status === 'not_found') return res.status(404).json({error: 'not found'});
    if (result.status === 'forbidden') return res.status(403).json({error: 'forbidden'});
    res.json(reportOutput(result.report));
  });
  app.get('/api/reports/jobs/:id', userAuth, async (req: Authed, res) => { const row = await db.prepare('SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.id=? AND j.user_id=?').get(req.user.id, req.params.id, req.user.id); row ? res.json(row) : res.status(404).json({error: 'not found'}); });
  app.get('/api/agents/jobs', agentAuth, async (req: Authed, res) => res.json(await db.prepare("SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.user_id=? AND j.status='pending' ORDER BY j.id LIMIT 1").all(req.agent.user_id, req.agent.user_id)));
  app.post('/api/agents/jobs/:id/claim', agentAuth, async (req: Authed, res) => { const result = await db.prepare("UPDATE report_jobs SET status='running',agent_id=?,claimed_at=? WHERE id=? AND user_id=? AND status='pending' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)").run(req.agent.id, now(), req.params.id, req.agent.user_id, req.agent.user_id); result.changes ? res.json(await db.prepare('SELECT * FROM report_jobs WHERE id=?').get(req.params.id)) : res.status(409).json({error: 'job unavailable'}); });
  app.get('/api/agents/jobs/:id/context', agentAuth, async (req: Authed, res) => {
    const job: any = await db.prepare('SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.id=? AND j.user_id=? AND j.agent_id=?').get(req.agent.user_id, req.params.id, req.agent.user_id, req.agent.id);
    if (!job) return res.status(404).json({error: 'not found'});
    const bounds = dateRangeUtc(isoDate(job.start_date), isoDate(job.end_date), normalizeTimezone(job.timezone));
    const events = (await db.prepare('SELECT e.*,r.name repository_name,r.normalized_remote FROM activity_events e JOIN repositories r ON r.id=e.repository_id WHERE e.user_id=? AND r.workspace_id=? AND e.occurred_at>=? AND e.occurred_at<=? ORDER BY e.occurred_at').all(job.user_id, job.workspace_id, bounds.from, bounds.to)).map((row: any) => ({...row, data: eventData(row.data)}));
    res.json({job, events});
  });
  app.post('/api/agents/jobs/:id/complete', agentAuth, required(['markdown']), async (req: Authed, res) => {
    const completed = await db.transaction(async () => {
      const job: any = await db.prepare("SELECT j.* FROM report_jobs j JOIN workspace_members wm ON wm.workspace_id=j.workspace_id AND wm.user_id=? WHERE j.id=? AND j.user_id=? AND j.status='running' AND j.agent_id=? FOR UPDATE").get(req.agent.user_id, req.params.id, req.agent.user_id, req.agent.id);
      if (!job) return false;
      if (job.target_report_id) {
        const updated = await db.prepare('UPDATE reports SET job_id=?,markdown=?,created_at=? WHERE id=? AND workspace_id=? AND user_id=?').run(job.id, req.body.markdown, now(), job.target_report_id, job.workspace_id, job.user_id);
        if (updated.changes !== 1) return false;
      } else {
        await db.prepare('INSERT INTO reports(job_id,workspace_id,user_id,start_date,end_date,timezone,include_diff,name,markdown,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(job.id, job.workspace_id, job.user_id, job.start_date, job.end_date, job.timezone, job.include_diff, job.report_name || defaultReportName(job.start_date, job.end_date), req.body.markdown, now());
      }
      await db.prepare("UPDATE report_jobs SET status='completed',completed_at=? WHERE id=?").run(now(), job.id);
      return true;
    });
    if (!completed) return res.status(409).json({error: 'job not claimed'});
    res.status(201).json({ok: true});
  });
  app.post('/api/agents/jobs/:id/fail', agentAuth, required(['error']), async (req: Authed, res) => { const result = await db.prepare("UPDATE report_jobs SET status='failed',error=?,completed_at=? WHERE id=? AND user_id=? AND agent_id=? AND status='running' AND workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=?)").run(req.body.error, now(), req.params.id, req.agent.user_id, req.agent.id, req.agent.user_id); res.status(result.changes ? 200 : 409).json({ok: Boolean(result.changes)}); });
  app.get('/api/workspaces/:id/reports', userAuth, requireMember, async (req, res) => {
    const rows = await db.prepare('SELECT r.id,r.job_id,r.workspace_id,r.user_id,r.start_date,r.end_date,r.timezone,r.include_diff,r.name,r.created_at,u.name user_name FROM reports r JOIN users u ON u.id=r.user_id WHERE r.workspace_id=? ORDER BY r.created_at DESC').all(req.params.id);
    res.json(rows.map(reportOutput));
  });
  app.get('/api/reports/:id', userAuth, async (req: Authed, res) => {
    const row = await db.prepare('SELECT r.* FROM reports r JOIN workspace_members wm ON wm.workspace_id=r.workspace_id WHERE r.id=? AND wm.user_id=?').get(req.params.id, req.user.id);
    row ? res.json(reportOutput(row)) : res.status(404).json({error: 'not found'});
  });

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
    const databaseBusy = error?.code === 'EMAXCONNSESSION' || /max clients reached in session mode/i.test(error?.message || '');
    if (databaseBusy) return res.status(503).set('retry-after', '5').json({error: 'TraceMini database is temporarily busy. Please retry in a few seconds.'});
    res.status(500).json({error: 'internal error'});
  });
  return app;
}
