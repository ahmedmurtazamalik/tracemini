import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const migrations = [`
CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE workspaces(id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE workspace_members(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id));
CREATE TABLE agents(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), machine_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, last_seen TEXT, created_at TEXT NOT NULL);
CREATE TABLE repositories(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, remote_url TEXT NOT NULL, normalized_remote TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id,normalized_remote));
CREATE TABLE local_clones(id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id), repository_id INTEGER NOT NULL REFERENCES repositories(id), local_key TEXT NOT NULL, branch TEXT, last_seen TEXT NOT NULL, UNIQUE(agent_id,local_key));
CREATE TABLE activity_events(id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), agent_id INTEGER NOT NULL REFERENCES agents(id), repository_id INTEGER NOT NULL REFERENCES repositories(id), type TEXT NOT NULL, occurred_at TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX activity_scope ON activity_events(repository_id,user_id,occurred_at);
CREATE TABLE report_jobs(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id), user_id INTEGER NOT NULL REFERENCES users(id), reporter TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL, agent_id INTEGER REFERENCES agents(id), error TEXT, created_at TEXT NOT NULL, claimed_at TEXT, completed_at TEXT);
CREATE TABLE reports(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES report_jobs(id), workspace_id INTEGER NOT NULL REFERENCES workspaces(id), user_id INTEGER NOT NULL REFERENCES users(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL);
`];

export type DB = Database.Database;
export function openDb(filename: string): DB {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), {recursive:true});
  const db = new Database(filename);
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  migrations.forEach((sql,i)=>{ if (!db.prepare('SELECT 1 FROM migrations WHERE version=?').get(i+1)) db.transaction(()=>{db.exec(sql);db.prepare('INSERT INTO migrations VALUES(?,?)').run(i+1,new Date().toISOString())})(); });
  return db;
}
