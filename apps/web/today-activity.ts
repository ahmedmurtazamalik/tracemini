type ActivityPoint = {total: number};
type ActivityUser = {name: string; totals: {commit: number; push: number; pull: number; stage: number}};

export function activityGraphPath(points: ActivityPoint[], width: number, height: number, maximum: number) {
  if (!points.length) return '';
  const safeMaximum = Math.max(1, maximum);
  return points.map((point, index) => {
    const x = points.length === 1 ? 0 : index * width / (points.length - 1);
    const y = height - point.total / safeMaximum * height;
    return `${index ? 'L' : 'M'}${Number(x.toFixed(2))} ${Number(y.toFixed(2))}`;
  }).join(' ');
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
  const count = (value: number, singular: string) => `${value} ${singular}${value === 1 ? '' : 's'}`;
  return `${user.name}: ${count(user.totals.commit, 'commit')}, ${count(user.totals.push, 'push')}, ${count(user.totals.pull, 'pull')}, ${count(user.totals.stage, 'stage')}`;
}
