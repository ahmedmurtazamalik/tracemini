import {getRouteContext, getRouteView} from './routes.js';

export type WorkspaceLoadKey = 'events' | 'repositories' | 'repositoryCandidates' | 'members' | 'reports' | 'agents' | 'stats' | 'report';
export type WorkspaceLoadItem = {key: WorkspaceLoadKey; path: string};

export function workspaceLoadPlan(
  route: string,
  workspaceId: number,
  dates: {from: string; to: string},
  timezone?: string,
): WorkspaceLoadItem[] {
  if (!workspaceId) return [];
  const view = getRouteView(route, workspaceId);
  const base = `/workspaces/${workspaceId}`;
  if (view === 'install') return [{key: 'agents', path: `${base}/agents`}];
  if (view === 'settings') return [
    {key: 'members', path: `${base}/members`},
    {key: 'repositories', path: `${base}/repositories?includeArchived=true`},
    {key: 'repositoryCandidates', path: `${base}/repository-candidates`},
    {key: 'agents', path: `${base}/agents`},
  ];
  if (view === 'reports') return [{key: 'reports', path: `${base}/reports`}];
  if (view === 'report') {
    const reportId = getRouteContext(route).reportId;
    return reportId ? [{key: 'report', path: `/reports/${reportId}`}] : [];
  }
  if (view !== 'dashboard') return [];

  const match = route.match(/^\/workspaces\/\d+\/(users|repositories)\/(\d+)/);
  const timezoneFilter = timezone ? `&timezone=${encodeURIComponent(timezone)}` : '';
  const eventPath = match
    ? `/${match[1]}/${match[2]}/activity?workspaceId=${workspaceId}&from=${dates.from}&to=${dates.to}${timezoneFilter}`
    : `${base}/activity?from=${dates.from}&to=${dates.to}${timezoneFilter}`;
  const statsFilter = match
    ? `&${match[1] === 'users' ? 'userId' : 'repositoryId'}=${match[2]}`
    : '';
  return [
    {key: 'events', path: eventPath},
    {key: 'repositories', path: `${base}/repositories?includeArchived=true`},
    {key: 'stats', path: `${base}/stats?from=${dates.from}&to=${dates.to}${timezoneFilter}${statsFilter}`},
  ];
}
