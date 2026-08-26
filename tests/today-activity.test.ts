import {describe, expect, it} from 'vitest';
import {activityGraphPath, activityGraphTicks, activityUserSummary} from '../apps/web/today-activity.js';

describe('today workspace activity graph', () => {
  it('draws a bounded smooth curve through each activity point', () => {
    const user = {name: 'Ada', totals: {commit: 2, push: 1, pull: 0, stage: 3}, points: [{total: 0}, {total: 3}, {total: 0}]};
    expect(activityGraphPath(user.points, 100, 40, 3)).toBe('M0 40 C16.67 40 33.33 0 50 0 C66.67 0 83.33 40 100 40');
    expect(activityUserSummary(user)).toBe('Ada: 2 commits, 1 push, 0 pulls, 3 stages');
    expect(activityUserSummary({...user, totals: {...user.totals, push: 2}})).toContain('2 pushes');
  });

  it('handles empty, single-point, and flat timelines without overshooting chart bounds', () => {
    expect(activityGraphPath([], 100, 40, 1)).toBe('');
    expect(activityGraphPath([{total: 2}], 100, 40, 4)).toBe('M0 20');
    expect(activityGraphPath([{total: 2}, {total: 2}, {total: 2}], 100, 40, 4)).toBe('M0 20 C16.67 20 33.33 20 50 20 C66.67 20 83.33 20 100 20');
  });

  it('uses readable integer ticks and preserves a zero scale for an idle day', () => {
    expect(activityGraphTicks(0)).toEqual({maximum: 1, ticks: [0, 1]});
    expect(activityGraphTicks(7)).toEqual({maximum: 10, ticks: [0, 5, 10]});
  });
});
