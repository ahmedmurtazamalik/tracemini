import {describe, expect, it} from 'vitest';
import {activityGraphPath, activityGraphTicks, activityUserSummary} from '../apps/web/today-activity.js';

describe('today workspace activity graph', () => {
  it('draws independent hourly activity and readable daily totals for each member', () => {
    const user = {name: 'Ada', totals: {commit: 2, push: 1, pull: 0, stage: 3}, hourly: [{total: 0}, {total: 3}, {total: 0}]};
    expect(activityGraphPath(user.hourly, 100, 40, 3)).toBe('M0 40 L50 0 L100 40');
    expect(activityUserSummary(user)).toBe('Ada: 2 commits, 1 push, 0 pulls, 3 stages');
  });

  it('uses readable integer ticks and preserves a zero scale for an idle day', () => {
    expect(activityGraphTicks(0)).toEqual({maximum: 1, ticks: [0, 1]});
    expect(activityGraphTicks(7)).toEqual({maximum: 10, ticks: [0, 5, 10]});
  });
});
