import React, {useEffect, useMemo, useRef, useState} from 'react';
import {activitySummary} from './activity-summary.js';
import {formatInTimezone} from './timezone.js';
import {emptyDay, journeyChains, journeyDates, type DayCounts, type JourneyData} from './journey-data.js';
import './journey.css';

type ActivityEvent = {id: number; repository_id: number; repository_name: string; user_name: string; type: string; occurred_at: string; data: Record<string, unknown>};
type Detail = {key: string; events?: ActivityEvent[]; error?: string};
type Props = {
  data: JourneyData; workspaceId: number; currentUserId: number;
  api: (path: string, options?: RequestInit) => Promise<unknown>;
  reload: () => Promise<void>; error: string;
  onAuthorizationFailure: (status: number) => Promise<void>;
};
const collapsedByWorkspace = new Map<number, Set<string>>();
const dateFormatters = {
  full: new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}),
  weekday: new Intl.DateTimeFormat('en', {weekday: 'short', timeZone: 'UTC'}),
  day: new Intl.DateTimeFormat('en', {day: '2-digit', timeZone: 'UTC'}),
};
const dateLabel = (date: string, part: keyof typeof dateFormatters = 'full') => dateFormatters[part].format(new Date(`${date}T00:00:00Z`));
const countLabel = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
const summaryLabel = (day: DayCounts) => day.total
  ? Object.entries(day.counts).map(([type, count]) => countLabel(count, type, type === 'push' ? 'pushes' : type === 'branch' ? 'branches' : `${type}s`)).join(' · ')
  : 'No recorded activity';

function EventEvidence({event, timezone, showProject}: {event: ActivityEvent; timezone: string; showProject: boolean}) {
  const message = event.type === 'commit' ? String(event.data.message || 'Commit') : event.type;
  return <article className="journey-evidence">
    <h4>{message}</h4>
    <p>{event.user_name}{showProject && ` · ${event.repository_name}`} · <time dateTime={event.occurred_at}>{formatInTimezone(event.occurred_at, timezone)}</time></p>
    {event.type !== 'commit' && <p>{activitySummary(event)}</p>}
    {event.data.branch != null && <p>Branch: <code>{String(event.data.branch)}</code></p>}
    {event.data.commitSha != null && <p>Commit: <code>{String(event.data.commitSha).slice(0, 12)}</code></p>}
    {event.data.filesChanged != null && <p>{countLabel(Number(event.data.filesChanged), 'file')} changed
      {event.data.insertions != null && ` · +${Number(event.data.insertions)}`}
      {event.data.deletions != null && ` / −${Number(event.data.deletions)}`}</p>}
  </article>;
}

export default function DevelopmentJourney({data, workspaceId, currentUserId, api, reload, error, onAuthorizationFailure}: Props) {
  const [view, setView] = useState<'person' | 'project'>('person');
  const [personMode, setPersonMode] = useState<'projects' | 'general'>('projects');
  const [person, setPerson] = useState(currentUserId);
  const [project, setProject] = useState(0);
  const [projectFilter, setProjectFilter] = useState(0);
  const [contributor, setContributor] = useState(0);
  const [selectedDate, setSelectedDate] = useState(data.to);
  const [selectedProject, setSelectedProject] = useState(0);
  const [range, setRange] = useState<7 | 14>(14);
  const [collapsed, setCollapsed] = useState(() => collapsedByWorkspace.get(workspaceId) || new Set<string>());
  const [detail, setDetail] = useState<Detail>();
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(50);
  const [refreshPending, setRefreshPending] = useState(false);
  const cache = useRef(new Map<string, ActivityEvent[]>());
  const authFailure = useRef(onAuthorizationFailure);
  authFailure.current = onAuthorizationFailure;

  const days = useMemo(() => journeyDates(data.from, data.to), [data.from, data.to]);
  const dayIndex = Math.max(0, days.indexOf(selectedDate));
  const date = days[dayIndex];
  const windowStart = range === 7 ? Math.floor(dayIndex / 7) * 7 : 0;
  const visibleDates = days.slice(windowStart, windowStart + range);
  const personId = data.people.some(item => item.id === person) ? person : data.people[0]?.id;
  const projectId = data.repositories.some(item => item.id === project) ? project : data.repositories[0]?.id;
  const userId = view === 'person' ? personId : contributor || undefined;
  const general = view === 'person' && personMode === 'general';
  const repositoryId = general ? undefined : view === 'project' ? projectId : projectFilter || undefined;
  const chains = useMemo(() => journeyChains(data, userId, repositoryId, general), [data, userId, repositoryId, general]);
  const projectNames = useMemo(() => new Map(data.repositories.map(repository => [repository.id, repository.name])), [data.repositories]);
  const activeChain = chains.find(chain => chain.id === selectedProject) || chains[0];
  const selected = activeChain?.days.get(date) || emptyDay;
  const detailKey = `${data.timezone}:${date}:${activeChain?.id || 0}:${userId || 0}`;
  const shownDetail = detail?.key === detailKey ? detail : undefined;
  const subject = view === 'person' ? data.people.find(item => item.id === personId)?.name : data.repositories.find(item => item.id === projectId)?.name;
  const activeDays = visibleDates.filter(day => chains.some(chain => (chain.days.get(day)?.total || 0) > 0)).length;

  // A refresh invalidates cached evidence; zoom and collapse do not participate
  // in the request dependencies. Aborted/old selections cannot replace details.
  useEffect(() => { cache.current.clear(); }, [data]);
  useEffect(() => {
    const controller = new AbortController();
    const key = detailKey;
    setLimit(50);
    setDetail({key});
    if (!activeChain || !selected.total) { setDetail({key, events: []}); return; }
    const cached = cache.current.get(key);
    if (cached) { setDetail({key, events: cached}); return; }
    const params = new URLSearchParams({from: date, to: date, timezone: data.timezone});
    if (activeChain.id) params.set('repositoryId', String(activeChain.id));
    if (userId !== undefined) params.set('userId', String(userId));
    void api(`/workspaces/${workspaceId}/activity?${params}`, {signal: controller.signal}).then(result => {
      if (controller.signal.aborted) return;
      const events = result as ActivityEvent[];
      if (cache.current.size >= 16) cache.current.delete(cache.current.keys().next().value!);
      cache.current.set(key, events);
      setDetail({key, events});
    }).catch(async (caught: unknown) => {
      if (controller.signal.aborted) return;
      const status = (caught as {status?: number}).status;
      if (status === 401 || status === 403) { cache.current.clear(); await authFailure.current(status); return; }
      setDetail({key, error: caught instanceof Error ? caught.message : 'Could not load activity.'});
    });
    return () => controller.abort();
  }, [detailKey, data, retry, api, workspaceId]);

  const toggleChain = (key: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    collapsedByWorkspace.set(workspaceId, next);
    return next;
  });
  const selectDay = (day: string, repository: number) => { setSelectedDate(day); if (repository) setSelectedProject(repository); };
  const events = shownDetail?.events || [];
  const renderedEvents = events.slice(0, limit);
  const commits = renderedEvents.filter(event => event.type === 'commit');
  const supporting = renderedEvents.filter(event => event.type !== 'commit');

  return <div className="page-stack development-journey" data-range={range} data-person-mode={general ? 'general' : 'projects'} style={{'--journey-day-columns': range} as React.CSSProperties}>
    <div className="journey-page-heading">
      <div><span className="eyebrow">Development activity</span><h1>Development journey</h1><p>Follow recorded Git activity by person and project over the last 14 days.</p></div>
      <button className="button secondary" disabled={refreshPending} onClick={async () => {
        setRefreshPending(true);
        try { await reload(); } finally { setRefreshPending(false); }
      }}>{refreshPending ? 'Refreshing…' : 'Refresh journey'}</button>
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    <section className="journey-controls" aria-label="Journey scope">
      <div className="journey-view-switch" role="group" aria-label="Journey perspective">
        <button aria-pressed={view === 'person'} onClick={() => setView('person')}>Person journey</button>
        <button aria-pressed={view === 'project'} onClick={() => setView('project')}>Project journey</button>
      </div>
      <div className="journey-selects">
        {view === 'person' ? <>
          <label>Person<select value={personId ?? ''} onChange={event => setPerson(Number(event.target.value))}>{data.people.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="journey-person-mode" role="group" aria-label="Person activity chains"><button aria-pressed={general} onClick={() => setPersonMode('general')}>General</button><button aria-pressed={!general} onClick={() => setPersonMode('projects')}>By project</button></div>
          {!general && <label>Project<select aria-label="Project filter" value={projectFilter} onChange={event => setProjectFilter(Number(event.target.value))}><option value={0}>All projects</option>{data.repositories.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archived)' : ''}</option>)}</select></label>}
        </> : <>
          <label>Project<select value={projectId ?? ''} onChange={event => setProject(Number(event.target.value))}>{data.repositories.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (archived)' : ''}</option>)}</select></label>
          <label>Contributor<select value={contributor} onChange={event => setContributor(Number(event.target.value))}><option value={0}>All contributors</option>{data.people.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </>}
      </div>
    </section>
    <div className="journey-window">
      <span aria-live="polite">{dateLabel(visibleDates[0])} — {dateLabel(visibleDates.at(-1)!)} · {data.timezone}</span>
      <div className="journey-zoom" role="group" aria-label="Timeline zoom">{([7, 14] as const).map(value => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value} days</button>)}</div>
      {range === 7 && <div className="journey-navigation"><button aria-label="Previous week" disabled={windowStart === 0} onClick={() => setSelectedDate(days[dayIndex - 7])}>←</button><button aria-label="Next week" disabled={windowStart + 7 >= days.length} onClick={() => setSelectedDate(days[dayIndex + 7])}>→</button></div>}
    </div>
    <div className="journey-layout">
      <section className="journey-map" aria-label="Project activity chains">
        <div className="journey-map-heading"><h2>{subject || 'No projects yet'}</h2><p>{countLabel(activeDays, 'active day')} · {countLabel(chains.reduce((count, chain) => count + chain.projectCount, 0), 'project')}{general ? ' combined' : ''}</p></div>
        {chains.map(chain => {
          const key = `${personId}:${chain.id}`;
          const expanded = general || view === 'project' || !collapsed.has(key);
          const visibleActive = visibleDates.filter(day => (chain.days.get(day)?.total || 0) > 0).length;
          return <section className="journey-project-chain" key={chain.id}>
            <h3>{view === 'person' && !general ? <button className="journey-chain-toggle" aria-expanded={expanded} aria-controls={`journey-chain-${chain.id}`} onClick={() => toggleChain(key)}>
              <span aria-hidden="true">{expanded ? '⌄' : '›'}</span><span>{chain.name}{chain.archived ? ' (archived)' : ''}</span><small>{visibleActive}/{visibleDates.length} active days</small>
            </button> : chain.name}</h3>
            <div id={`journey-chain-${chain.id}`} hidden={!expanded}>
              {expanded && <ol className="journey-chain-days">{visibleDates.map(day => {
                const activity = chain.days.get(day) || emptyDay;
                const selected = day === date && chain.id === activeChain?.id;
                const previews = (activity.previews || []).map(preview => ({
                  ...preview,
                  label: `${preview.type === 'commit' ? '' : `${preview.type}: `}${preview.text.replace(/^refs\/(?:heads|tags)\//, '')}`,
                  project: general ? projectNames.get(preview.repositoryId) : undefined,
                }));
                const previewText = previews.map(preview => [preview.project, preview.label].filter(Boolean).join(': ')).join('\n');
                return <li key={day}><button className={`journey-chain-day${activity.total ? ' active' : ' quiet'}${selected ? ' selected' : ''}`} aria-pressed={selected}
                  aria-label={`${chain.name}, ${dateLabel(day)}, ${summaryLabel(activity)}${previewText ? `: ${previewText}` : ''}`} title={previewText || summaryLabel(activity)} onClick={() => selectDay(day, chain.id)}>
                  <span className="journey-chain-date">{dateLabel(day, 'weekday')}<strong>{dateLabel(day, 'day')}</strong></span>
                  <span className="journey-day-dot" aria-hidden="true" />
                  {activity.total > 0 && <span className="journey-day-previews">{previews.length ? previews.map((preview, index) => <span className="journey-day-preview" key={index}>
                    {preview.project && <small>{preview.project}</small>}<span>{preview.label}</span>
                  </span>) : <span className="journey-day-preview"><span>{summaryLabel(activity)}</span></span>}</span>}
                  <span className="journey-chain-footer"><strong className="journey-chain-total">{activity.total || '—'}</strong><span className="journey-chain-caption">{activity.total ? activity.total === 1 ? 'event' : 'events' : 'Quiet'}</span></span>
                </button></li>;
              })}</ol>}
            </div>
          </section>;
        })}
        {!chains.length && <div className="journey-empty"><h3>No project activity in this range</h3><p>Projects appear when a member tracks a repository or syncs Git activity. Try another person or project.</p></div>}
        <div className="journey-map-footer"><span><i /> Recorded Git activity</span><span>Quiet = no synced events</span><a href="#journey-day-details">Selected day details ↓</a></div>
      </section>
      <aside className="journey-details" id="journey-day-details" aria-label="Selected day details">
        <div className="journey-details-header"><span className="eyebrow">Day details</span><div className="journey-navigation"><button aria-label="Previous day" disabled={dayIndex === 0} onClick={() => setSelectedDate(days[dayIndex - 1])}>←</button><button aria-label="Next day" disabled={dayIndex === days.length - 1} onClick={() => setSelectedDate(days[dayIndex + 1])}>→</button></div></div>
        <div className="journey-selected-date" aria-live="polite"><h2>{dateLabel(date)}</h2><p>{activeChain?.name}{userId !== undefined && ` · ${data.people.find(item => item.id === userId)?.name || ''}`}</p><p>{summaryLabel(selected)}</p></div>
        {!selected.total ? <div className="journey-empty"><h3>No recorded activity</h3><p>No Git events were synced for this project, person, and day.</p></div>
          : shownDetail?.error ? <div className="journey-empty" role="alert"><p>{shownDetail.error}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}>Retry activity</button></div>
          : !shownDetail?.events ? <p className="journey-loading" role="status">Loading day activity…</p>
          : <div className="journey-detail-events">
            {commits.length > 0 && <section><h3>Commits</h3>{commits.map(event => <EventEvidence key={`${event.id}:${event.repository_id}`} event={event} timezone={data.timezone} showProject={general} />)}</section>}
            {supporting.length > 0 && <details><summary>Supporting activity ({supporting.length})</summary>{supporting.map(event => <EventEvidence key={`${event.id}:${event.repository_id}`} event={event} timezone={data.timezone} showProject={general} />)}</details>}
            {!events.length && <p>No events remain for this selection. Refresh the journey to update its counts.</p>}
            {events.length > limit && <button className="button secondary" onClick={() => setLimit(value => value + 50)}>Show more activity ({events.length - limit})</button>}
            {(events.length >= 500 || events.length < selected.total) && <p className="journey-truncation">Showing the latest {Math.min(limit, events.length)} of {selected.total} events. Up to 500 recent events are available per day.</p>}
          </div>}
        <p className="journey-details-note">Recorded activity describes Git events, not completion or productivity.</p>
      </aside>
    </div>
  </div>;
}
