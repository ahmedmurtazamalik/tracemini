import {describe, expect, it} from 'vitest';
import {activityGraphPath, activityGraphTicks, activitySeriesColorMap, activityUserSummary, compactActivityNumber} from '../apps/web/today-activity.js';

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

  it('assigns stable distinct colors regardless of series order and honors explicit colors', () => {
    const first = activitySeriesColorMap([{key: 'Ada'}, {key: 'Grace'}, {key: 'Linus'}]);
    const reordered = activitySeriesColorMap([{key: 'Linus'}, {key: 'Ada'}, {key: 'Grace'}]);
    expect(reordered).toEqual(first);
    expect(new Set(Object.values(first)).size).toBe(3);
    expect(activitySeriesColorMap([{key: 'Ada', color: '#123456'}]).Ada).toBe('#123456');
    const withExplicitPaletteColor = activitySeriesColorMap([{key: 'Ada', color: '#3b82f6'}, {key: 'Grace'}]);
    expect(withExplicitPaletteColor.Grace).not.toBe('#3b82f6');
  });

  it('compacts large axis and tooltip values', () => {
    expect(compactActivityNumber(0)).toBe('0');
    expect(compactActivityNumber(1_250)).toBe('1.3K');
    expect(compactActivityNumber(34_000_000)).toBe('34M');
  });
});
