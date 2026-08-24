import type {Config} from './config.js';

export type DevicePairing = {agentToken: string; agentId: number; workspaceId: number};

export function rebindDeviceConfig(config: Config, serverUrl: string, pairing: DevicePairing): Config {
  const {userToken: _userToken, ...local} = config;
  return {
    ...local,
    serverUrl,
    agentToken: pairing.agentToken,
    agentId: pairing.agentId,
    workspaceId: pairing.workspaceId,
    clones: [],
  };
}
