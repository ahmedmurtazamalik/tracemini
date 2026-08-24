import {newDb} from 'pg-mem';
import type {Pool} from 'pg';
import {DB} from './db.js';

export async function openTestDb() {
  const memory = newDb({autoCreateForeignKeyIndices: true});
  const adapter = memory.adapters.createPg();
  const db = new DB(new adapter.Pool() as unknown as Pool);
  // Fresh pg-mem schemas already use the current native types. Compatibility
  // migrations are exercised against real PostgreSQL in the live smoke gate.
  await db.migrate({advisoryLock: false, compatibilityMigrations: false});
  return db;
}