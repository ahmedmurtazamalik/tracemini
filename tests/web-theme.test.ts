import {describe, expect, it} from 'vitest';
import {normalizeTheme, nextTheme, themeToggleLabel, themeColor} from '../apps/web/theme.js';

describe('web theme preference', () => {
  it('restores only supported persisted themes', () => {
    expect(normalizeTheme('night')).toBe('night');
    expect(normalizeTheme('day')).toBe('day');
    expect(normalizeTheme('unexpected')).toBe('day');
    expect(normalizeTheme(null)).toBe('day');
  });

  it('describes and applies the opposite mode through an accessible toggle', () => {
    expect(nextTheme('day')).toBe('night');
    expect(themeToggleLabel('day')).toBe('Switch to night mode');
    expect(nextTheme('night')).toBe('day');
    expect(themeToggleLabel('night')).toBe('Switch to day mode');
  });

  it('provides browser chrome colors for both modes', () => {
    expect(themeColor('day')).toBe('#eef0e9');
    expect(themeColor('night')).toBe('#0d1511');
  });
});
