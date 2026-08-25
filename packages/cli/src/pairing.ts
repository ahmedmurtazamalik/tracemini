import type {Config} from './config.js';

export type DevicePairing = {agentToken: string; agentId: number; workspaceId: number};

export function normalizeServerUrl(serverUrl: string) {
  const parsed = new URL(serverUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !local) parsed.protocol = 'https:';
  return parsed.origin;
}

export function previousDeviceTokenForServer(config: Config, nextServerUrl: string) {
  if (!config.agentToken || !config.serverUrl) return undefined;
  try {
    return normalizeServerUrl(config.serverUrl) === normalizeServerUrl(nextServerUrl) ? config.agentToken : undefined;
  } catch {
    return undefined;
  }
}

export function rebindDeviceConfig(config: Config, serverUrl: string, pairing: DevicePairing): Config {
  const {userToken: _userToken, ...local} = config;
  return {
    ...local,
    serverUrl,
    agentToken: pairing.agentToken,
    agentId: pairing.agentId,
    workspaceId: pairing.workspaceId,
    watchedPaths: [],
    clones: [],
  };
}

export function rebindWorkspaceConfig(config: Config, workspaceId?: number, forceReset = false): Config {
  if (!forceReset && config.workspaceId === workspaceId) return {...config};
  const rebound = {...config, watchedPaths: [], clones: []};
  if (workspaceId) rebound.workspaceId = workspaceId;
  else delete rebound.workspaceId;
  return rebound;
}
