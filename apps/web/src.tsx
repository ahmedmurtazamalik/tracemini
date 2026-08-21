import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './style.css';

const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`/api${path}`, { ...init, headers: {'content-type': 'application/json', ...(localStorage.token ? {authorization: `Bearer ${localStorage.token}`} : {}), ...init.headers} });
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
};
const navigate = (path: string) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); };
const today = () => new Date().toISOString().slice(0, 10);

function Auth({onLogin}: {onLogin: (token: string) => void}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  return <main className="auth"><h1>TraceMini</h1><p>Local Git activity, clear team context.</p><form onSubmit={async event => { event.preventDefault(); try { const body = Object.fromEntries(new FormData(event.currentTarget)); const result = await request(`/auth/${mode}`, {method: 'POST', body: JSON.stringify(body)}); localStorage.token = result.token; onLogin(result.token); } catch (caught: any) { setError(caught.message); } }}>{mode === 'register' && <input name="name" placeholder="Name" required/>}<input name="email" type="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><button>{mode === 'login' ? 'Log in' : 'Create account'}</button></form><button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Back to login'}</button><p className="error">{error}</p></main>;
}

function Install({workspaceId}: {workspaceId: number}) {
  const [installation, setInstallation] = useState<any>();
  const mint = async () => setInstallation(await request('/agents/installations', {method: 'POST', body: JSON.stringify({workspaceId})}));
  const Copy = ({command}: {command: string}) => <div className="command"><pre>{command}</pre><button onClick={() => navigator.clipboard.writeText(command)}>Copy</button></div>;
  return <section><h2>Install CLI on Linux</h2><p>Requires Linux, Node.js 22+, curl, and a working systemd user session. Windows support is deferred.</p>{!installation ? <button onClick={mint}>Generate install command</button> : <><h3>Install</h3><p>Copy and run this command. It downloads the installer before running it, installs into your user account, and starts the agent without sudo.</p><Copy command={installation.installCommand}/><small>This install command expires at {new Date(installation.expiresAt).toLocaleTimeString()} and works once.</small><h3>Verify installation and agent health</h3><Copy command={'export PATH="$HOME/.local/bin:$PATH"'}/><Copy command="command -v tracemini"/><Copy command="tracemini status"/><Copy command="systemctl --user status tracemini.service --no-pager"/><Copy command="journalctl --user -u tracemini.service -n 50 --no-pager"/><p>If the service has not logged anything yet, the journal may show <code>-- No entries --</code>; that is normal immediately after installation.</p></>}</section>;
}

function Trend({daily}: {daily: any[]}) {
  const max = Math.max(1, ...daily.map(day => day.commits));
  return <div className="trend">{daily.map(day => <div title={`${day.date}: ${day.commits} commits`}><i style={{height: `${Math.max(8, day.commits / max * 100)}%`}}/><small>{day.date.slice(5)}</small></div>)}</div>;
}

function Activity({events, workspaceId}: {events: any[]; workspaceId: number}) {
  return <section><h2>Recent activity</h2>{events.map(event => <div className="event" key={event.id}><time>{new Date(event.occurred_at).toLocaleString()}</time><button className="inline" onClick={() => navigate(`/workspaces/${workspaceId}/users/${event.user_id}`)}>{event.user_name}</button> · <button className="inline" onClick={() => navigate(`/workspaces/${workspaceId}/repositories/${event.repository_id}`)}>{event.repository_name}</button><p>{event.type} {event.data.message || event.data.branch || ''}{event.type === 'push' && ` · ${event.data.confirmation || 'unconfirmed'}`}</p></div>)}</section>;
}

function Settings({workspace, members, repositories, agents, reload}: any) {
  if (workspace.role !== 'Manager') return <section><h2>Settings</h2><p>Only Managers can change workspace settings.</p></section>;
  const mutate = async (path: string, method = 'POST', body?: any) => { await request(path, {method, body: body === undefined ? undefined : JSON.stringify(body)}); await reload(); };
  return <div className="settings"><section><h2>Members</h2>{members.map((member: any) => <div className="row"><span>{member.name} <small>{member.email}</small></span><select value={member.role} onChange={event => mutate(`/workspaces/${workspace.id}/members/${member.id}`, 'PATCH', {role: event.target.value})}><option>Manager</option><option>Member</option></select><button onClick={() => mutate(`/workspaces/${workspace.id}/members/${member.id}`, 'DELETE')}>Remove</button></div>)}</section><section><h2>Invite</h2><code>{workspace.invite_enabled ? workspace.invite_code : 'Disabled'}</code><button onClick={() => mutate(`/workspaces/${workspace.id}/invite/regenerate`)}>Regenerate</button><button onClick={() => mutate(`/workspaces/${workspace.id}/invite/disable`)}>Disable</button></section><section><h2>Repositories</h2>{repositories.map((repo: any) => <div className="row"><span>{repo.name}</span><button onClick={() => mutate(`/workspaces/${workspace.id}/repositories/${repo.id}`, 'PATCH', {archived: !repo.archived})}>{repo.archived ? 'Unarchive' : 'Archive'}</button></div>)}</section><section><h2>Agents</h2>{agents.map((agent: any) => <div className="row"><span><i className={`status ${agent.status}`}/> {agent.machine_name} · {agent.user_name} ({agent.status})</span>{agent.status !== 'revoked' && <button onClick={() => mutate(`/workspaces/${workspace.id}/agents/${agent.id}/revoke`)}>Revoke</button>}</div>)}</section><section className="danger"><h2>Delete workspace</h2><button onClick={() => confirm('Permanently delete this workspace and its activity?') && mutate(`/workspaces/${workspace.id}`, 'DELETE')}>Delete workspace</button></section></div>;
}

function App() {
  const [token, setToken] = useState(localStorage.token || '');
  const [route, setRoute] = useState(location.pathname);
  const [user, setUser] = useState<any>();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [workspaceId, setWorkspaceId] = useState(0);
  const [events, setEvents] = useState<any[]>([]);
  const [repositories, setRepositories] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [refreshes, setRefreshes] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({totals: {}, daily: []});
  const [report, setReport] = useState<any>();
  const [error, setError] = useState('');
  const [dates, setDates] = useState({from: today(), to: today()});
  useEffect(() => { const listener = () => setRoute(location.pathname); addEventListener('popstate', listener); return () => removeEventListener('popstate', listener); }, []);
  const workspace = useMemo(() => workspaces.find(item => item.id === workspaceId), [workspaces, workspaceId]);
  const loadIdentity = async () => { try { const [me, list] = await Promise.all([request('/auth/me'), request('/workspaces')]); setUser(me); setWorkspaces(list); const routeWorkspace = Number(location.pathname.match(/^\/workspaces\/(\d+)/)?.[1]); setWorkspaceId(routeWorkspace || workspaceId || list[0]?.id || 0); } catch { localStorage.removeItem('token'); setToken(''); } };
  const loadWorkspace = async () => {
    if (!workspaceId) return;
    try {
      const match = route.match(/^\/workspaces\/\d+\/(users|repositories)\/(\d+)/);
      const eventPath = match ? `/${match[1]}/${match[2]}/activity?workspaceId=${workspaceId}&from=${dates.from}&to=${dates.to}` : `/workspaces/${workspaceId}/activity?from=${dates.from}&to=${dates.to}`;
      const statsFilter = match ? `&${match[1] === 'users' ? 'userId' : 'repositoryId'}=${match[2]}` : '';
      const [activity, repos, people, history, machines, refreshHistory, summary] = await Promise.all([request(eventPath), request(`/workspaces/${workspaceId}/repositories?includeArchived=true`), request(`/workspaces/${workspaceId}/members`), request(`/workspaces/${workspaceId}/reports`), request(`/workspaces/${workspaceId}/agents`), request(`/workspaces/${workspaceId}/refresh`), request(`/workspaces/${workspaceId}/stats?from=${dates.from}&to=${dates.to}${statsFilter}`)]);
      setEvents(activity); setRepositories(repos); setMembers(people); setReports(history); setAgents(machines); setRefreshes(refreshHistory); setStats(summary);
      const reportId = route.match(/^\/workspaces\/\d+\/reports\/(\d+)/)?.[1];
      setReport(reportId ? await request(`/reports/${reportId}`) : undefined);
    } catch (caught: any) { setError(caught.message); }
  };
  useEffect(() => { if (token) loadIdentity(); }, [token]);
  useEffect(() => { loadWorkspace(); }, [workspaceId, route, dates.from, dates.to]);
  useEffect(() => { if (!workspaceId) return; const timer = setInterval(loadWorkspace, 5000); return () => clearInterval(timer); }, [workspaceId, route, dates.from, dates.to]);
  if (!token) return <Auth onLogin={setToken}/>;
  const isSettings = route.endsWith('/settings');
  const isInstall = route.endsWith('/install');
  return <><header><button className="brand" onClick={() => navigate(`/workspaces/${workspaceId}`)}>TraceMini</button><select value={workspaceId} onChange={event => { setWorkspaceId(+event.target.value); navigate(`/workspaces/${event.target.value}`); }}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><nav><button onClick={() => navigate(`/workspaces/${workspaceId}`)}>Dashboard</button><button onClick={() => navigate(`/workspaces/${workspaceId}/install`)}>Install CLI</button><button onClick={() => navigate(`/workspaces/${workspaceId}/settings`)}>Settings</button></nav><span>{user?.name}</span><button onClick={async () => { await request('/auth/logout', {method: 'POST'}); localStorage.removeItem('token'); setToken(''); }}>Logout</button></header><main><section className="toolbar"><label>From <input type="date" value={dates.from} onChange={event => setDates({...dates, from: event.target.value})}/></label><label>To <input type="date" value={dates.to} onChange={event => setDates({...dates, to: event.target.value})}/></label><button onClick={async () => { const name = prompt('Workspace name'); if (name) { await request('/workspaces', {method: 'POST', body: JSON.stringify({name})}); await loadIdentity(); } }}>New workspace</button><button onClick={async () => { const inviteCode = prompt('Invite code'); if (inviteCode) { await request('/workspaces/join', {method: 'POST', body: JSON.stringify({inviteCode})}); await loadIdentity(); } }}>Join</button></section>{isInstall ? <Install workspaceId={workspaceId}/> : isSettings ? <Settings workspace={workspace} members={members} repositories={repositories} agents={agents} reload={async () => { await loadIdentity(); await loadWorkspace(); }}/> : report ? <section className="report"><button onClick={() => navigate(`/workspaces/${workspaceId}`)}>← Report history</button><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.markdown}</ReactMarkdown></section> : <><h1>{route.includes('/users/') ? 'User activity' : route.includes('/repositories/') ? 'Repository activity' : 'Activity dashboard'}</h1><div className="metrics"><article><big>{stats.totals.commits || 0}</big><small>commits</small></article><article><big>{stats.totals.filesChanged || 0}</big><small>files changed</small></article><article><big>{stats.totals.insertions || 0}</big><small>insertions</small></article><article><big>{stats.totals.deletions || 0}</big><small>deletions</small></article></div><Trend daily={stats.daily}/><div className="grid"><Activity events={events} workspaceId={workspaceId}/><aside><h2>Repositories</h2>{repositories.filter(repo => !repo.archived).map(repo => <button className="repo" onClick={() => navigate(`/workspaces/${workspaceId}/repositories/${repo.id}`)}>{repo.name}<small>{repo.clone_count} local clone(s)</small></button>)}<h2>Refresh</h2><button onClick={async () => { await request(`/workspaces/${workspaceId}/refresh`, {method: 'POST'}); await loadWorkspace(); }}>Refresh repositories</button>{refreshes.slice(0, 3).map(item => <p><small>{item.status}{item.error ? `: ${item.error}` : item.repositories_found !== null ? ` · ${item.repositories_found} found` : ''}</small></p>)}<h2>Agents</h2>{agents.map(agent => <p><i className={`status ${agent.status}`}/> {agent.machine_name} · {agent.status}</p>)}<h2>Reports</h2><button onClick={async () => { const reporter = prompt('Reporter: codex or hermes', 'codex') || 'codex'; await request('/reports/jobs', {method: 'POST', body: JSON.stringify({workspaceId: String(workspaceId), startDate: dates.from, endDate: dates.to, reporter})}); }}>Generate report</button>{reports.map(item => <button className="repo" onClick={() => navigate(`/workspaces/${workspaceId}/reports/${item.id}`)}>{item.start_date} — {item.end_date}<small>{item.user_name}</small></button>)}</aside></div></>}<p className="error">{error}</p></main></>;
}

createRoot(document.getElementById('root')!).render(<App/>);
