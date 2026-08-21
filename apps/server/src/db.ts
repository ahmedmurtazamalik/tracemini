import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const migrations = [
  `
  CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
  CREATE TABLE workspaces(id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), invite_code TEXT UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE workspace_members(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id));
  CREATE TABLE agents(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), machine_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last_seen TEXT, created_at TEXT NOT NULL);
  CREATE TABLE repositories(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, remote_url TEXT NOT NULL, normalized_remote TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id,normalized_remote));
  CREATE TABLE local_clones(id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id), repository_id INTEGER NOT NULL REFERENCES repositories(id), local_key TEXT NOT NULL, branch TEXT, last_seen TEXT NOT NULL, UNIQUE(agent_id,local_key));
  CREATE TABLE activity_events(id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), agent_id INTEGER NOT NULL REFERENCES agents(id), repository_id INTEGER NOT NULL REFERENCES repositories(id), type TEXT NOT NULL, occurred_at TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX activity_scope ON activity_events(repository_id,user_id,occurred_at);
  CREATE TABLE report_jobs(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), user_id INTEGER NOT NULL REFERENCES users(id), reporter TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL, agent_id INTEGER REFERENCES agents(id), error TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT);
  CREATE TABLE reports(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES report_jobs(id), workspace_id INTEGER NOT NULL REFERENCES workspaces(id), user_id INTEGER NOT NULL REFERENCES users(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL);
  `,
  `
  UPDATE workspace_members SET role='Manager' WHERE lower(role) IN ('owner','manager');
  UPDATE workspace_members SET role='Member' WHERE lower(role)='member';
  ALTER TABLE agents ADD COLUMN revoked_at TEXT;
  ALTER TABLE repositories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE local_clones ADD COLUMN head_sha TEXT;
  ALTER TABLE local_clones ADD COLUMN remote_head_sha TEXT;
  CREATE TABLE setup_codes(
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE refresh_requests(
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requested_by INTEGER NOT NULL REFERENCES users(id),
    agent_id INTEGER REFERENCES agents(id),
    status TEXT NOT NULL,
    repositories_found INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE pending_pushes(
    id INTEGER PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    repository_id INTEGER NOT NULL REFERENCES repositories(id),
    remote_name TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    ref TEXT NOT NULL,
    expected_sha TEXT NOT NULL,
    observed_sha TEXT,
    status TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    completed_at TEXT
  );
  `,
  `ALTER TABLE workspaces ADD COLUMN invite_enabled INTEGER NOT NULL DEFAULT 1;`,
  `
  ALTER TABLE pending_pushes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_pushes ADD COLUMN next_check_at TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE;
  UPDATE agents SET workspace_id=(SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id=agents.user_id ORDER BY wm.workspace_id LIMIT 1) WHERE workspace_id IS NULL;
  CREATE INDEX idx_agents_workspace ON agents(workspace_id);
  `,
];

export type DB = Database.Database;

export function openDb(filename: string): DB {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), {recursive: true});
  }
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  migrations.forEach((sql, index) => {
    const version = index + 1;
    if (db.prepare('SELECT 1 FROM migrations WHERE version=?').get(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations VALUES(?,?)').run(version, new Date().toISOString());
    })();
  });
  return db;
}
