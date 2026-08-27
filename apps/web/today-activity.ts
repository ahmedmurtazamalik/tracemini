type ActivityPoint = {total: number};
type ActivityUser = {name: string; totals: {commit: number; push: number; pull: number; stage: number}};

const ACTIVITY_SERIES_PALETTE = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
  '#f97316', '#14b8a6', '#a855f7', '#eab308', '#0ea5e9', '#f43f5e', '#10b981', '#6366f1',
];

function seriesHash(value: string) {
  let hash = 2166136261;
  for (const character of value.toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function activitySeriesColorMap(series: Array<{key: string; color?: string}>) {
  const entries = [...new Map(series.map(item => [item.key, item])).values()]
    .sort((left, right) => seriesHash(left.key) - seriesHash(right.key) || left.key.localeCompare(right.key));
  const used = new Set(entries.flatMap(entry => entry.color ? [entry.color] : []));
  const colors: Record<string, string> = {};
  for (const entry of entries) if (entry.color) colors[entry.key] = entry.color;
  for (const entry of entries) {
    if (entry.color) continue;
    let color: string | undefined;
    const start = seriesHash(entry.key) % ACTIVITY_SERIES_PALETTE.length;
    for (let offset = 0; !color && offset < ACTIVITY_SERIES_PALETTE.length; offset++) {
      const candidate = ACTIVITY_SERIES_PALETTE[(start + offset) % ACTIVITY_SERIES_PALETTE.length];
      if (!used.has(candidate)) color = candidate;
    }
    let attempt = 0;
    while (!color || used.has(color)) {
      color = `hsl(${(seriesHash(entry.key) + attempt * 47) % 360} 72% 56%)`;
      attempt += 1;
    }
    colors[entry.key] = color;
    used.add(color);
  }
  return colors;
}

export function compactActivityNumber(value: number) {
  const absolute = Math.abs(Number(value) || 0);
  const sign = value < 0 ? '-' : '';
  for (const [suffix, divisor] of [['B', 1_000_000_000], ['M', 1_000_000], ['K', 1_000]] as const) {
    if (absolute >= divisor) {
      const scaled = absolute / divisor;
      return `${sign}${(scaled < 10 ? scaled.toFixed(1) : scaled.toFixed(0)).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return `${sign}${Math.round(absolute)}`;
}

export function activityGraphPath(points: ActivityPoint[], width: number, height: number, maximum: number) {
  if (!points.length) return '';
  const safeMaximum = Math.max(1, maximum);
  const coordinates = points.map((point, index) => ({
    x: points.length === 1 ? 0 : index * width / (points.length - 1),
    y: height - point.total / safeMaximum * height,
  }));
  const number = (value: number) => Number(value.toFixed(2));
  let path = `M${number(coordinates[0].x)} ${number(coordinates[0].y)}`;
  for (let index = 1; index < coordinates.length; index++) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const third = (current.x - previous.x) / 3;
    path += ` C${number(previous.x + third)} ${number(previous.y)} ${number(current.x - third)} ${number(current.y)} ${number(current.x)} ${number(current.y)}`;
  }
  return path;
}

export function activityGraphTicks(maximum: number, tickCount = 4) {
  const safeMaximum = Math.max(1, Math.ceil(maximum));
  const roughStep = safeMaximum / Math.max(1, tickCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep || 1));
  const normalized = roughStep / magnitude;
  const step = Math.max(1, (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude);
  const chartMaximum = Math.max(step, Math.ceil(safeMaximum / step) * step);
  const ticks = Array.from({length: Math.floor(chartMaximum / step) + 1}, (_, index) => index * step);
  return {maximum: chartMaximum, ticks};
}

export function activityUserSummary(user: ActivityUser) {
  const count = (value: number, singular: string, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;
  return `${user.name}: ${count(user.totals.commit, 'commit')}, ${count(user.totals.push, 'push', 'pushes')}, ${count(user.totals.pull, 'pull')}, ${count(user.totals.stage, 'stage')}`;
}
