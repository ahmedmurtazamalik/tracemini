export type JourneyDay = {userId: number; repositoryId: number; date: string; counts: Record<string, number>; total: number};
export type JourneyRepository = {id: number; name: string; archived: boolean; userIds: number[]};
export type JourneyData = {
  from: string; to: string; timezone: string;
  people: Array<{id: number; name: string}>;
  repositories: JourneyRepository[];
  days: JourneyDay[];
};
export type DayCounts = Pick<JourneyDay, 'counts' | 'total'>;
export const emptyDay: DayCounts = {counts: {}, total: 0};

export function journeyDates(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  return Array.from({length: Math.min(14, Math.max(0, Math.round((end - start) / 86_400_000) + 1))}, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

export function journeyChains(data: JourneyData, userId?: number, repositoryId?: number) {
  const byRepository = new Map<number, Map<string, DayCounts>>();
  for (const day of data.days) {
    if (userId !== undefined && day.userId !== userId) continue;
    if (repositoryId !== undefined && day.repositoryId !== repositoryId) continue;
    const days = byRepository.get(day.repositoryId) || new Map<string, DayCounts>();
    const current = days.get(day.date) || {counts: {}, total: 0};
    current.total += day.total;
    for (const [type, count] of Object.entries(day.counts)) current.counts[type] = (current.counts[type] || 0) + count;
    days.set(day.date, current);
    byRepository.set(day.repositoryId, days);
  }
  return data.repositories.filter(repository => repositoryId !== undefined ? repository.id === repositoryId
    : byRepository.has(repository.id) || (userId !== undefined && !repository.archived && repository.userIds.includes(userId)))
    .map(repository => ({...repository, days: byRepository.get(repository.id) || new Map<string, DayCounts>()}));
}
