import {DataType, newDb} from 'pg-mem';
import type {Pool} from 'pg';
import {DB} from './db.js';

export async function openTestDb() {
  const memory = newDb({autoCreateForeignKeyIndices: true});
  memory.public.registerFunction({
    name: 'date_trunc',
    args: [DataType.text, DataType.timestamptz],
    returns: DataType.timestamptz,
    implementation: (part: string, value: Date) => {
      if (part !== 'hour') throw new Error(`unsupported date_trunc part: ${part}`);
      const date = new Date(value);
      date.setUTCMinutes(0, 0, 0);
      return date;
    },
  });
  memory.public.registerFunction({
    name: 'date_bin',
    args: [DataType.interval, DataType.timestamptz, DataType.timestamptz],
    returns: DataType.timestamptz,
    implementation: (stride: any, source, origin) => {
      const strideMs = Number(stride?.milliseconds || 0)
        + Number(stride?.seconds || 0) * 1_000
        + Number(stride?.minutes || 0) * 60_000
        + Number(stride?.hours || 0) * 3_600_000;
      if (!strideMs) throw new Error('unsupported date_bin stride');
      return new Date(new Date(origin).getTime() + Math.floor((new Date(source).getTime() - new Date(origin).getTime()) / strideMs) * strideMs);
    },
  });
  memory.public.registerFunction({
    name: 'replace',
    args: [DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement),
  });
  const adapter = memory.adapters.createPg();
  const db = new DB(new adapter.Pool() as unknown as Pool);
  // Fresh pg-mem schemas already use the current native types. Compatibility
  // migrations are exercised against real PostgreSQL in the live smoke gate.
  await db.migrate({advisoryLock: false, compatibilityMigrations: false});
  return db;
}
