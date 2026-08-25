import {describe, expect, it, vi} from 'vitest';
import type {Config} from '../packages/cli/src/config.js';
import {normalizeServerUrl, previousDeviceTokenForServer, rebindDeviceConfig, rebindWorkspaceConfig} from '../packages/cli/src/pairing.js';
import {restartStartup, stopStartup} from '../packages/cli/src/install.js';

const existing = (): Config => ({
  serverUrl: 'https://old.example.test',
  userToken: 'old-user',
  agentToken: 'old-device',
  agentId: 9,
  workspaceId: 3,
  watchedPaths: ['/home/ali', '/work/project'],
  clones: [{path: '/work/project', repositoryId: 44, normalizedRemote: 'example/repo', name: 'repo'}],
  reporter: 'hermes',
  pollMs: 5000,
});

describe('CLI device re-pairing', () => {
  it('keeps local preferences but clears repository state and installs the new credential', () => {
    const rebound = rebindDeviceConfig(existing(), 'https://new.example.test', {
      agentToken: 'new-device', agentId: 10, workspaceId: 8,
    });

    expect(rebound).toMatchObject({
      serverUrl: 'https://new.example.test',
      agentToken: 'new-device',
      agentId: 10,
      workspaceId: 8,
      watchedPaths: [],
      clones: [],
      reporter: 'hermes',
      pollMs: 5000,
    });
    expect(rebound).not.toHaveProperty('userToken');
  });

  it('clears watched roots and clones when the workspace binding changes', () => {
    expect(rebindWorkspaceConfig(existing(), 8)).toMatchObject({workspaceId: 8, watchedPaths: [], clones: [], agentToken: 'old-device'});
    expect(rebindWorkspaceConfig(existing(), 3)).toMatchObject({workspaceId: 3, watchedPaths: ['/home/ali', '/work/project']});
  });

  it('restarts the existing Linux user service after credentials change', () => {
    const execute = vi.fn();
    restartStartup('linux', execute as any);
    expect(execute).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'tracemini.service'], {stdio: 'ignore'});
    expect(() => restartStartup('win32', execute as any)).toThrow(/Linux only/);
  });

  it('upgrades hosted HTTP URLs to HTTPS without changing local development URLs', () => {
    expect(normalizeServerUrl('http://tracemini.vercel.app')).toBe('https://tracemini.vercel.app');
    expect(normalizeServerUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(previousDeviceTokenForServer(existing(), 'https://old.example.test')).toBe('old-device');
    expect(previousDeviceTokenForServer(existing(), 'https://new.example.test')).toBeUndefined();
  });

  it('cancels syncing when an active service cannot be stopped', () => {
    const active = vi.fn((_command: string, args: string[]) => {
      if (args.includes('stop')) throw new Error('stop failed');
      return undefined;
    });
    expect(() => stopStartup('linux', active as any)).toThrow(/cancelled safely/);

    const inactive = vi.fn(() => { throw new Error('not active'); });
    expect(() => stopStartup('linux', inactive as any)).not.toThrow();
  });
});
