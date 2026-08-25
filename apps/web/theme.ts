export type Theme = 'day' | 'night';

export const THEME_STORAGE_KEY = 'theme';

export function normalizeTheme(value: string | null | undefined): Theme {
  return value === 'night' ? 'night' : 'day';
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'night' ? 'day' : 'night';
}

export function themeToggleLabel(theme: Theme) {
  return theme === 'night' ? 'Switch to day mode' : 'Switch to night mode';
}

export function themeColor(theme: Theme) {
  return theme === 'night' ? '#0d1511' : '#eef0e9';
}

export function applyTheme(theme: Theme, root = document.documentElement) {
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  meta?.setAttribute('content', themeColor(theme));
}
