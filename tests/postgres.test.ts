import {describe, expect, it} from 'vitest';

// PostgreSQL is the server's only application database. This test deliberately
// exercises the same schema migration entrypoint against an in-memory Postgres
// implementation so unit tests never mutate the hosted Supabase project.
describe('PostgreSQL database', () => {
  it('converts parameters without rewriting SQL literals or comments', async () => {
    const {postgresSql} = await import('../apps/server/src/db.js');
    expect(postgresSql("SELECT '?' literal, ? value -- ? comment\n/* ? */"))
      .toBe("SELECT '?' literal, $1 value -- ? comment\n/* ? */");
    expect(postgresSql('SELECT $$?$$ literal, ? value')).toBe('SELECT $$?$$ literal, $1 value');
  });

  it('uses the bundled Supabase CA with certificate and hostname verification', async () => {
    const {normalizePostgresConnectionString, postgresPoolConfig} = await import('../apps/server/src/db.js');
    const connectionString =
      'postgresql://postgres.example:***@pooler.supabase.com:5432/postgres?sslmode=require';
    const normalized = new URL(normalizePostgresConnectionString(connectionString));
    const config = postgresPoolConfig(connectionString);
    expect(normalized.searchParams.has('sslmode')).toBe(false);
    expect(config.ssl).toMatchObject({rejectUnauthorized: true});
    expect(config.max).toBe(3);
    const previousVercel = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const serverlessConfig = postgresPoolConfig(connectionString);
      expect(serverlessConfig.max).toBe(1);
      expect(new URL(serverlessConfig.connectionString!).port).toBe('6543');
      expect(serverlessConfig.options).toBeUndefined();
      expect(serverlessConfig.idleTimeoutMillis).toBe(1_000);
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
    expect((config.ssl as {ca: string}).ca).toContain('BEGIN CERTIFICATE');
  });

  it('opens a migrated Postgres database with the TraceMini schema', async () => {
    const {openTestDb} = await import('../apps/server/src/test-db.js');
    const db = await openTestDb();
    try {
      const migrations = await db.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
      expect(migrations.rows.map((row: any) => row.version)).toEqual([1, 3, 4, 5, 9, 11, 12]);
      for (const migration of migrations.rows) expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
      const reportJobColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='report_jobs'");
      expect(reportJobColumns.rows.map((row: any) => row.column_name)).toEqual(expect.arrayContaining(['custom_prompt', 'target_report_id', 'report_name']));
      const reportColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='reports'");
      expect(reportColumns.rows.map((row: any) => row.column_name)).toEqual(expect.arrayContaining(['name']));
      const agentColumns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='agents'");
      expect(agentColumns.rows.map((row: any) => row.column_name)).toEqual(expect.arrayContaining(['removed_at']));
      const tables = await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
      );
      expect(tables.rows.map((row: any) => row.table_name)).toEqual(expect.arrayContaining([
        'users',
        'workspaces',
        'workspace_members',
        'agents',
        'repositories',
        'activity_events',
        'report_jobs',
        'reports',
      ]));
    } finally {
      await db.close();
    }
  });
});
