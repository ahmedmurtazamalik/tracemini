export type JourneyPreview = {repositoryId: number; type: string; text: string; at: string};
export type JourneyDay = {userId: number; repositoryId: number; date: string; counts: Record<string, number>; total: number; previews?: JourneyPreview[]};
export type JourneyRepository = {id: number; name: string; archived: boolean; userIds: number[]};
export type JourneyData = {
  from: string; to: string; timezone: string;
  people: Array<{id: number; name: string}>;
  repositories: JourneyRepository[];
  days: JourneyDay[];
};
export type DayCounts = Pick<JourneyDay, 'counts' | 'total' | 'previews'>;
export const emptyDay: DayCounts = {counts: {}, total: 0};

export function journeyDates(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  return Array.from({length: Math.min(14, Math.max(0, Math.round((end - start) / 86_400_000) + 1))}, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function addDay(current: DayCounts, day: DayCounts) {
  current.total += day.total;
  for (const [type, count] of Object.entries(day.counts)) current.counts[type] = (current.counts[type] || 0) + count;
  const previews = [...(current.previews || []), ...(day.previews || [])]
    .sort((a, b) => Number(b.type === 'commit') - Number(a.type === 'commit') || b.at.localeCompare(a.at) || a.repositoryId - b.repositoryId || a.text.localeCompare(b.text));
  if (previews.length) current.previews = previews.filter((preview, index) => previews.findIndex(other => other.repositoryId === preview.repositoryId && other.type === preview.type && other.text === preview.text) === index).slice(0, 2);
  return current;
}

export function journeyChains(data: JourneyData, userId?: number, repositoryId?: number, general = false) {
  const byRepository = new Map<number, Map<string, DayCounts>>();
  for (const day of data.days) {
    if (userId !== undefined && day.userId !== userId) continue;
    if (repositoryId !== undefined && day.repositoryId !== repositoryId) continue;
    const days = byRepository.get(day.repositoryId) || new Map<string, DayCounts>();
    const current = days.get(day.date) || {counts: {}, total: 0};
    days.set(day.date, addDay(current, day));
    byRepository.set(day.repositoryId, days);
  }
  const projects = data.repositories.filter(repository => repositoryId !== undefined ? repository.id === repositoryId
    : byRepository.has(repository.id) || (userId !== undefined && !repository.archived && repository.userIds.includes(userId)))
    .map(repository => ({...repository, projectCount: 1, days: byRepository.get(repository.id) || new Map<string, DayCounts>()}));
  if (!general) return projects;
  const days = new Map<string, DayCounts>();
  for (const project of projects) for (const [date, day] of project.days) {
    days.set(date, addDay(days.get(date) || {counts: {}, total: 0}, day));
  }
  return [{id: 0, name: 'All projects', archived: false, userIds: userId === undefined ? [] : [userId], projectCount: projects.length, days}];
}
