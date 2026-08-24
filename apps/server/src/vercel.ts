import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {createApp} from './app.js';
import {openPostgresDb, type DB} from './db.js';

type OpenDb = () => Promise<DB>;

export function createVercelHandler(options: {openDb?: OpenDb; webDir?: string} = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = options.webDir ?? path.resolve(here, '../../web/dist');
  const openDb = options.openDb ?? (() => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    return openPostgresDb(process.env.DATABASE_URL);
  });
  let appPromise: ReturnType<typeof initialize> | undefined;

  function initialize() {
    return openDb()
      .then(db => createApp(db, webDir))
      .catch(error => {
        appPromise = undefined;
        throw error;
      });
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const app = await (appPromise ??= initialize());
      app(req, res);
    } catch (error) {
      console.error('TraceMini serverless initialization failed:', error);
      if (res.headersSent) return;
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({error: 'service temporarily unavailable'}));
    }
  };
}

export default createVercelHandler();
