import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {tick} from '../packages/cli/src/agent.js';
import {type Config} from '../packages/cli/src/config.js';

describe('agent service work ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRACEMINI_HOME;
  });

  it('checks reports before repository scan requests and ordinary maintenance', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-work-order-'));
    process.env.TRACEMINI_HOME = temporary;
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      paths.push(pathname);
      if (pathname === '/api/agents/heartbeat') return Response.json({ok: true});
      if (pathname === '/api/agents/jobs' || pathname === '/api/agents/refresh-requests' || pathname === '/api/agents/pushes' || pathname === '/api/agents/repository-selections') return Response.json([]);
      return Response.json({error: `unexpected ${pathname}`}, {status: 404});
    }));
    const config: Config = {
      serverUrl: 'http://tracemini.test',
      agentToken: 'agent-token',
      workspaceId: 8,
      watchedPaths: [],
      clones: [],
      reporter: 'codex',
      pollMs: 2000,
    };

    await tick(config, new Map());

    expect(paths).toEqual([
      '/api/agents/jobs',
      '/api/agents/refresh-requests',
      '/api/agents/repository-selections',
      '/api/agents/pushes',
    ]);
    fs.rmSync(temporary, {recursive: true, force: true});
  });
});
