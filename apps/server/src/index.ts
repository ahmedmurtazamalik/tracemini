import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPostgresDb} from './db.js';
import {createApp} from './app.js';

async function main() {
  const isTestMemory = process.env.NODE_ENV === 'test' && process.env.DATABASE_URL === 'pg-mem://isolated';
  if (!isTestMemory && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = isTestMemory
    ? await (await import('./test-db.js')).openTestDb()
    : await openPostgresDb(process.env.DATABASE_URL!);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT || 3000);
  const server = createApp(db, path.resolve(here, '../../web/dist')).listen(port, () => console.log(`TraceMini listening on http://localhost:${port}`));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forced = setTimeout(() => {
      console.error('TraceMini shutdown timed out');
      process.exit(1);
    }, 10_000).unref();
    server.close(async error => {
      try {
        if (error) throw error;
        await db.close();
      } catch (closeError) {
        console.error('TraceMini shutdown failed:', closeError);
        process.exitCode = 1;
      } finally {
        clearTimeout(forced);
      }
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
