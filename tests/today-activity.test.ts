import {describe, expect, it} from 'vitest';
import {activityGraphPath, activityUserSummary} from '../apps/web/today-activity.js';

describe('today workspace activity graph', () => {
  it('draws one cumulative line and readable totals for each workspace member', () => {
    const user = {name: 'Ada', totals: {commit: 2, push: 1, pull: 0, stage: 3}, hourly: [{total: 0}, {total: 3}, {total: 6}]};
    expect(activityGraphPath(user.hourly, 100, 40, 6)).toBe('M0 40 L50 20 L100 0');
    expect(activityUserSummary(user)).toBe('Ada: 2 commits, 1 push, 0 pulls, 3 stages');
  });
});
