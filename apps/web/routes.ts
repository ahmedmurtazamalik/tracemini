export type RouteView = 'dashboard' | 'reports' | 'install' | 'settings' | 'workspace-required' | 'report';

export type RouteContext = {workspaceId?: number; reportId?: number};

export function getRouteContext(pathname: string): RouteContext {
  const match = pathname.match(/^\/workspaces\/(\d+)(?:\/reports\/(\d+))?/);
  if (!match) return {};
  return {workspaceId: Number(match[1]), ...(match[2] ? {reportId: Number(match[2])} : {})};
}

export function reportMatchesRoute(report: {id: number; workspace_id: number} | undefined, pathname: string) {
  const context = getRouteContext(pathname);
  return Boolean(report && context.reportId && report.id === context.reportId && report.workspace_id === context.workspaceId);
}

export function workspacePath(workspaceId: number, section = '') {
  if (!workspaceId) return section ? `/${section}` : '/';
  return `/workspaces/${workspaceId}${section ? `/${section}` : ''}`;
}

export function getRouteView(pathname: string, workspaceId: number): RouteView {
  const isInstall = /\/(?:install)\/?$/.test(pathname);
  const isSettings = /\/(?:settings)\/?$/.test(pathname);
  if (!workspaceId && (isInstall || isSettings)) return 'workspace-required';
  if (isInstall) return 'install';
  if (isSettings) return 'settings';
  if (/\/reports\/\d+\/?$/.test(pathname)) return 'report';
  if (/\/reports\/?$/.test(pathname)) return 'reports';
  return 'dashboard';
}
