export type JourneyPreview = {repositoryId: number; type: string; text: string; at: string};
export type JourneyDay = {userId: number; repositoryId: number; date: string; counts: Record<string, number>; total: number; lastActivityAt?: string; previews?: JourneyPreview[]};
export type JourneyRepository = {id: number; name: string; archived: boolean; userIds: number[]};
export type JourneyData = {
  from: string; to: string; timezone: string;
  people: Array<{id: number; name: string}>;
  repositories: JourneyRepository[];
  days: JourneyDay[];
};
export type DayCounts = Pick<JourneyDay, 'counts' | 'total' | 'lastActivityAt' | 'previews'>;
export const emptyDay: DayCounts = {counts: {}, total: 0};

export function workDescription(message: unknown) {
  const text = String(message || '').split(/\r?\n/, 1)[0].trim();
  if (/^(?:merge (?:pull request|branch|remote-tracking branch|tag)\b|(?:wip on|on|index on|untracked files on) [^:]+:|stash\b|fixup!|squash!)/i.test(text)) return '';
  return text.replace(/^(?:feat|fix|perf|refactor|docs|test|build|ci|chore|style)(?:\([^)]*\))?!?:\s*/i, '').replace(/^\w/, letter => letter.toUpperCase());
}

export function journeyDates(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  return Array.from({length: Math.min(14, Math.max(0, Math.round((end - start) / 86_400_000) + 1))}, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function addDay(current: DayCounts, day: DayCounts) {
  current.total += day.total;
  if (day.lastActivityAt && (!current.lastActivityAt || day.lastActivityAt > current.lastActivityAt)) current.lastActivityAt = day.lastActivityAt;
  for (const [type, count] of Object.entries(day.counts)) current.counts[type] = (current.counts[type] || 0) + count;
  const previews = [...(current.previews || []), ...(day.previews || [])]
    .sort((a, b) => Number(b.type === 'commit') - Number(a.type === 'commit') || b.at.localeCompare(a.at) || a.repositoryId - b.repositoryId || a.text.localeCompare(b.text));
  if (previews.length) current.previews = previews.filter((preview, index) => previews.findIndex(other => other.repositoryId === preview.repositoryId && other.type === preview.type && other.text === preview.text) === index).slice(0, 2);
  return current;
}

export function journeyChains(data: JourneyData, userId?: number, repositoryId?: number, general = false, from = data.from, to = data.to) {
  const byRepository = new Map<number, Map<string, DayCounts>>();
  for (const day of data.days) {
    if (!day.total || day.date < from || day.date > to) continue;
    if (userId !== undefined && day.userId !== userId) continue;
    if (repositoryId !== undefined && day.repositoryId !== repositoryId) continue;
    const days = byRepository.get(day.repositoryId) || new Map<string, DayCounts>();
    const current = days.get(day.date) || {counts: {}, total: 0};
    days.set(day.date, addDay(current, {...day, lastActivityAt: day.lastActivityAt || `${day.date}T00:00:00Z`}));
    byRepository.set(day.repositoryId, days);
  }
  const projects = data.repositories.filter(repository => byRepository.has(repository.id))
    .map(repository => ({...repository, projectCount: 1, days: byRepository.get(repository.id)!, lastActivityAt: [...byRepository.get(repository.id)!.values()].reduce((latest, day) => day.lastActivityAt! > latest ? day.lastActivityAt! : latest, '')}))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.name.localeCompare(b.name) || a.id - b.id);
  if (!general || !projects.length) return projects;
  const days = new Map<string, DayCounts>();
  for (const project of projects) for (const [date, day] of project.days) {
    days.set(date, addDay(days.get(date) || {counts: {}, total: 0}, day));
  }
  return [{id: 0, name: 'All projects', archived: false, userIds: userId === undefined ? [] : [userId], projectCount: projects.length, days, lastActivityAt: projects[0].lastActivityAt}];
}
