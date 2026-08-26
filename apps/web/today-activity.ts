type ActivityPoint = {total: number};
type ActivityUser = {name: string; totals: {commit: number; push: number; pull: number; stage: number}};

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
