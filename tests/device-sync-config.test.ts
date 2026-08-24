import {describe, expect, it, vi} from 'vitest';
import type {Config} from '../packages/cli/src/config.js';
import {rebindDeviceConfig} from '../packages/cli/src/pairing.js';
import {restartStartup} from '../packages/cli/src/install.js';

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
  it('keeps local preferences but clears server-bound clone identity and installs the new credential', () => {
    const rebound = rebindDeviceConfig(existing(), 'https://new.example.test', {
      agentToken: 'new-device', agentId: 10, workspaceId: 8,
    });

    expect(rebound).toMatchObject({
      serverUrl: 'https://new.example.test',
      agentToken: 'new-device',
      agentId: 10,
      workspaceId: 8,
      watchedPaths: ['/home/ali', '/work/project'],
      clones: [],
      reporter: 'hermes',
      pollMs: 5000,
    });
    expect(rebound).not.toHaveProperty('userToken');
  });

  it('restarts the existing Linux user service after credentials change', () => {
    const execute = vi.fn();
    restartStartup('linux', execute as any);
    expect(execute).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'tracemini.service'], {stdio: 'ignore'});
    expect(() => restartStartup('win32', execute as any)).toThrow(/Linux only/);
  });
});
