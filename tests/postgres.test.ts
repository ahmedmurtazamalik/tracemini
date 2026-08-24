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
    expect((config.ssl as {ca: string}).ca).toContain('BEGIN CERTIFICATE');
  });

  it('opens a migrated Postgres database with the TraceMini schema', async () => {
    const {openTestDb} = await import('../apps/server/src/test-db.js');
    const db = await openTestDb();
    try {
      const migrations = await db.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
      expect(migrations.rows.map((row: any) => row.version)).toEqual([1, 3, 4]);
      for (const migration of migrations.rows) expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
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
        'password_reset_tokens',
        'report_jobs',
        'reports',
      ]));
    } finally {
      await db.close();
    }
  });
});
