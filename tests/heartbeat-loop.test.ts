import {afterEach, describe, expect, it, vi} from 'vitest';
import {startHeartbeatLoop} from '../packages/cli/src/agent.js';

describe('independent agent heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('continues sending heartbeats while other agent work is still running', async () => {
    vi.useFakeTimers();
    let heartbeats = 0;
    const stop = startHeartbeatLoop(async () => {
      heartbeats++;
    }, 100);

    await vi.advanceTimersByTimeAsync(350);
    stop();

    expect(heartbeats).toBe(3);
  });
});
