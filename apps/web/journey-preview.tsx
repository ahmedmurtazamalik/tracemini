import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {applyTheme, nextTheme, themeToggleLabel, type Theme} from './theme.js';
import './refresh.css';
import './journey-preview.css';

type View = 'person' | 'project';
const people = {ali: 'Ali Majid', ahmed: 'Ahmed Malik', sara: 'Sara Khan'};
const projects = {tracemini: 'TraceMini', portal: 'Client portal', system: 'Design system'};
type Person = keyof typeof people;
type Project = keyof typeof projects;
type Outcome = {day: number; person: Person; project: Project; title: string; detail: string; evidence: string[]};

// Illustrative outcomes only. This entry point never reads or writes workspace data.
const outcomes: Outcome[] = [
  {day: 0, person: 'ali', project: 'tracemini', title: 'A smoother first connection', detail: 'Simplified the device setup steps so a new teammate can connect their machine with less guidance.', evidence: ['Clarify the CLI connection steps', 'Show a useful connection status']},
  {day: 0, person: 'ahmed', project: 'tracemini', title: 'Clearer workspace invitations', detail: 'Made pending invitations easier to find and accept.', evidence: ['Improve the invitation inbox']},
  {day: 1, person: 'ali', project: 'portal', title: 'An easier way to sign in', detail: 'Added clearer field guidance and useful feedback when sign-in fails.', evidence: ['Improve sign-in validation']},
  {day: 1, person: 'sara', project: 'tracemini', title: 'A consistent dashboard layout', detail: 'Aligned the dashboard panels and spacing across desktop and smaller screens.', evidence: ['Align dashboard panel spacing']},
  {day: 2, person: 'ali', project: 'tracemini', title: 'Choose what gets tracked', detail: 'Made repository selection explicit, with a clear view of the repositories included in the workspace.', evidence: ['Add repository selection controls', 'Explain repository selection states']},
  {day: 2, person: 'ahmed', project: 'tracemini', title: 'More reliable repository discovery', detail: 'Improved discovery feedback when a watched folder contains several repositories.', evidence: ['Improve repository scan feedback']},
  {day: 3, person: 'sara', project: 'system', title: 'Reusable form patterns', detail: 'Documented input labels, validation messages, and keyboard focus styles.', evidence: ['Document accessible form patterns']},
  {day: 4, person: 'ali', project: 'system', title: 'A shared color language', detail: 'Brought buttons and status treatments onto the same day and night palettes.', evidence: ['Align shared theme colors']},
  {day: 4, person: 'ahmed', project: 'portal', title: 'A clearer project overview', detail: 'Grouped recent client work into a more readable overview.', evidence: ['Group recent project updates']},
  {day: 5, person: 'ali', project: 'tracemini', title: 'Reports reach the right place', detail: 'Added delivery options for scheduled reports, with readable messages for the team.', evidence: ['Add scheduled report delivery']},
  {day: 5, person: 'ahmed', project: 'tracemini', title: 'Recover from a failed delivery', detail: 'Kept saved reports available for retry when a delivery attempt fails.', evidence: ['Keep delivery status with saved reports', 'Add a delivery retry action']},
  {day: 5, person: 'sara', project: 'tracemini', title: 'A better sharing preview', detail: 'Added the project image and descriptive metadata used when a link is shared.', evidence: ['Add sharing image and metadata']},
  {day: 7, person: 'ali', project: 'portal', title: 'Find the right account faster', detail: 'Improved the account list with clearer names and useful empty states.', evidence: ['Improve account list empty states']},
  {day: 7, person: 'sara', project: 'tracemini', title: 'Reports are easier to read', detail: 'Adjusted headings and spacing so report sections are easier to scan.', evidence: ['Refine report typography']},
  {day: 8, person: 'ali', project: 'tracemini', title: 'More context behind the work', detail: 'Made room for document context alongside recorded development activity.', evidence: ['Include document context in reports']},
  {day: 8, person: 'ahmed', project: 'tracemini', title: 'Clearer context validation', detail: 'Explained which context files can be attached and why a file may need attention.', evidence: ['Clarify document validation messages']},
  {day: 9, person: 'ali', project: 'system', title: 'A calmer night theme', detail: 'Improved contrast and brought dark surfaces into a consistent palette.', evidence: ['Refine night theme contrast']},
  {day: 9, person: 'sara', project: 'portal', title: 'A useful mobile navigation', detail: 'Made the account navigation fit comfortably on smaller screens.', evidence: ['Improve mobile navigation spacing']},
  {day: 10, person: 'ali', project: 'tracemini', title: 'Fewer setup roadblocks', detail: 'Explained how to install the local tools needed to read scanned documents.', evidence: ['Add local OCR setup guidance']},
  {day: 10, person: 'ahmed', project: 'portal', title: 'Safer account updates', detail: 'Added clear confirmation and validation feedback to account changes.', evidence: ['Validate account update fields']},
  {day: 11, person: 'ali', project: 'tracemini', title: 'Report delivery, made resilient', detail: 'Added a clear retry path for saved reports, so a temporary delivery failure does not require generating the report again.', evidence: ['Add retry action to saved reports', 'Show report delivery status']},
  {day: 11, person: 'ali', project: 'portal', title: 'Onboarding with a clear next step', detail: 'Simplified the first-run checklist and kept the next available action visible.', evidence: ['Simplify the onboarding checklist']},
  {day: 11, person: 'ahmed', project: 'tracemini', title: 'Scheduled reports can keep moving', detail: 'Let an available connected device pick up a scheduled report when the preferred device is unavailable.', evidence: ['Try available devices for scheduled reports', 'Track device attempts for report jobs']},
  {day: 11, person: 'sara', project: 'tracemini', title: 'Delivery states at a glance', detail: 'Refined the saved-report interface so pending, delivered, and failed states are easy to distinguish.', evidence: ['Clarify report delivery state labels']},
  {day: 12, person: 'ali', project: 'tracemini', title: 'A clearer activity timeline', detail: 'Made date labels and selected-day feedback easier to follow.', evidence: ['Refine timeline date labels']},
  {day: 12, person: 'ahmed', project: 'system', title: 'Consistent empty states', detail: 'Aligned the wording and layout used when a view has no recorded activity.', evidence: ['Align empty-state messaging']},
  {day: 13, person: 'ali', project: 'system', title: 'The small details, aligned', detail: 'Finished a pass over focus indicators and compact controls.', evidence: ['Polish keyboard focus indicators']},
  {day: 13, person: 'sara', project: 'tracemini', title: 'A final dashboard polish', detail: 'Improved the spacing and responsive layout of the activity overview.', evidence: ['Polish the responsive activity overview']},
];

const days = Array.from({length: 14}, (_, index) => new Date(Date.UTC(2026, 9, 17 + index)));
const formatDate = (day: number, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', {...options, timeZone: 'UTC'}).format(days[day]);
const dayLabels = days.map((_, day) => ({date: formatDate(day, {day: '2-digit'}), weekday: formatDate(day, {weekday: 'short'}), full: formatDate(day, {month: 'long', day: 'numeric'})}));
const initials = (name: string) => name.split(' ').map(part => part[0]).join('');

function Icon({name}: {name: 'journey' | 'sun' | 'moon' | 'chevron' | 'commit' | 'arrow'}) {
  const paths = {
    journey: <><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h7a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h7"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    commit: <><circle cx="12" cy="12" r="4"/><path d="M3 12h5m8 0h5"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function JourneyPreview() {
  const [view, setView] = useState<View>('person');
  const [person, setPerson] = useState<Person>('ali');
  const [project, setProject] = useState<Project>('tracemini');
  const [filter, setFilter] = useState('all');
  const [selectedDay, setSelectedDay] = useState(11);
  const [selectedProject, setSelectedProject] = useState<Project>('tracemini');
  const [range, setRange] = useState<7 | 14>(14);
  const [collapsedChains, setCollapsedChains] = useState(() => new Set<string>());
  const [theme, setTheme] = useState<Theme>('day');
  const windowStart = range === 7 ? Math.floor(selectedDay / 7) * 7 : 0;
  const windowEnd = windowStart + range;
  const weekStarts = range === 14 ? [0, 7] : [windowStart];
  const visible = outcomes.filter(item => view === 'person'
    ? item.person === person && (filter === 'all' || item.project === filter)
    : item.project === project && (filter === 'all' || item.person === filter));
  const byDay = days.map((_, day) => visible.filter(item => item.day === day));
  const windowDays = byDay.slice(windowStart, windowEnd);
  const projectChains = (Object.entries(projects) as [Project, string][]).map(([id, name]) => ({id, name, days: byDay.map(items => items.filter(item => item.project === id))}))
    .filter(chain => filter === 'all' ? chain.days.some(items => items.length) : chain.id === filter);
  const detailProject = projectChains.some(chain => chain.id === selectedProject) ? selectedProject : projectChains[0]?.id;
  const selected = byDay[selectedDay].filter(item => view === 'project' || item.project === detailProject);
  const groupNames = view === 'person' ? projects : people;
  const groups = Object.entries(groupNames).map(([id, name]) => ({name, items: selected.filter(item => (view === 'person' ? item.project : item.person) === id)})).filter(group => group.items.length);
  const subject = view === 'person' ? people[person] : projects[project];
  const relatedCount = view === 'person' ? projectChains.length : new Set(windowDays.flat().map(item => item.person)).size;
  const switchView = (next: View) => { setView(next); setFilter('all'); };
  const toggleTheme = () => { const next = nextTheme(theme); setTheme(next); applyTheme(next); };
  const toggleChain = (key: string) => setCollapsedChains(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const selectDay = (day: number, projectId?: Project) => {
    setSelectedDay(day);
    if (projectId) setSelectedProject(projectId);
    if (window.matchMedia('(max-width: 1170px)').matches) document.getElementById('journey-day-details')?.scrollIntoView({block: 'start', behavior: 'instant'});
  };

  return <div className="journey-preview" data-range={range} style={{'--journey-day-columns': range} as React.CSSProperties}>
    <a className="journey-skip" href="#journey-main">Skip to journey</a>
    <header className="journey-app-header">
      <a className="journey-brand" href="/journey-preview.html"><img src="/brand/tracemini-mark.png" alt=""/><span>TraceMini<span className="journey-brand-divider">/</span><small>Studio workspace</small></span></a>
      <div className="journey-header-actions"><span className="journey-preview-badge"><i/> Interactive preview</span><button className="journey-theme" aria-label={themeToggleLabel(theme)} onClick={toggleTheme}><Icon name={theme === 'day' ? 'moon' : 'sun'}/></button></div>
    </header>

    <main id="journey-main" className="journey-main">
      <div className="journey-page-heading"><div><div className="journey-eyebrow"><Icon name="journey"/> THE BIG PICTURE</div><h1>Development journey<span>.</span></h1><p>Follow the work. See how each day moves the story forward.</p></div>
        <div className="journey-window">
          <span className="journey-window-dates" aria-live="polite">{dayLabels[windowStart].date} — {dayLabels[windowEnd - 1].date} Oct, 2026</span>
          <div className="journey-zoom" role="group" aria-label="Timeline zoom">{([7, 14] as const).map(value => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{value} days</button>)}</div>
          {range === 7 && <div className="journey-day-navigation"><button aria-label="Previous week" disabled={windowStart === 0} onClick={() => setSelectedDay(day => day - 7)}><span className="journey-back"><Icon name="chevron"/></span></button><button aria-label="Next week" disabled={windowEnd === days.length} onClick={() => setSelectedDay(day => day + 7)}><Icon name="chevron"/></button></div>}
        </div>
      </div>

      <section className="journey-controls" aria-label="Journey scope">
        <div className="journey-view-switch" role="group" aria-label="Journey perspective"><button aria-pressed={view === 'person'} onClick={() => switchView('person')}>Person journey</button><button aria-pressed={view === 'project'} onClick={() => switchView('project')}>Project journey</button></div>
        <div className="journey-selects"><label>{view === 'person' ? 'Person' : 'Project'}<select aria-label={view === 'person' ? 'Person' : 'Project'} value={view === 'person' ? person : project} onChange={event => view === 'person' ? setPerson(event.target.value as Person) : setProject(event.target.value as Project)}>{Object.entries(view === 'person' ? people : projects).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><span className="journey-control-divider"/><label>{view === 'person' ? 'Project' : 'Contributor'}<select aria-label={view === 'person' ? 'Project filter' : 'Contributor filter'} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{view === 'person' ? 'All projects' : 'All contributors'}</option>{Object.entries(groupNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></div>
      </section>

      <div className="journey-layout">
        <section className="journey-map" aria-labelledby="journey-map-title">
          <div className="journey-map-heading"><div className="journey-subject"><span className={`journey-subject-icon ${view}`} aria-hidden="true">{view === 'person' ? initials(subject) : <Icon name="journey"/>}</span><div><h2 id="journey-map-title">{view === 'person' ? `${subject.split(' ')[0]}'s projects` : `${subject}'s journey`}</h2><p>{windowDays.filter(items => items.length).length} active days <span>·</span> {relatedCount} {view === 'person' ? 'project chains' : 'contributors'}</p></div></div><span className="journey-sample-label">SAMPLE DATA</span></div>

          {view === 'person' ? <div className="journey-project-chains">
            <div className="journey-chain-weeks" aria-hidden="true">{weekStarts.map(start => <span key={start}>WEEK {start / 7 + 1} <span>{dayLabels[start].date} — {dayLabels[start + 6].date} Oct</span></span>)}</div>
            {projectChains.map(chain => {
              const key = `${person}-${chain.id}`;
              const collapsed = collapsedChains.has(key);
              const chainDays = chain.days.slice(windowStart, windowEnd);
              return <section className={`journey-project-chain${collapsed ? ' collapsed' : ''}`} key={key} aria-label={`${chain.name} activity for ${subject}`}>
              <div className="journey-chain-heading"><h3><button className="journey-chain-toggle" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${chain.name} project chain`} aria-expanded={!collapsed} aria-controls={`chain-${key}`} onClick={() => toggleChain(key)}><span className="journey-group-mark" aria-hidden="true">{chain.name[0]}</span><span>{chain.name}</span><span className="journey-chain-count">{chainDays.filter(items => items.length).length} active days</span><span className="journey-chain-chevron"><Icon name="chevron"/></span></button></h3></div>
              <div id={`chain-${key}`} hidden={collapsed}>{!collapsed && <ol className="journey-chain-days">
                {chainDays.map((items, offset) => {
                  const day = windowStart + offset;
                  const isSelected = detailProject === chain.id && selectedDay === day;
                  return <li key={day}><button className={`journey-chain-day${items.length ? '' : ' quiet'}${isSelected ? ' selected' : ''}`} aria-label={`${chain.name}, ${dayLabels[day].full}: ${items.length ? items.map(item => item.title).join('; ') : 'No recorded activity'}`} aria-pressed={isSelected} aria-controls="journey-day-details" onClick={() => selectDay(day, chain.id)}>
                    <span className="journey-chain-date"><span>{dayLabels[day].weekday}</span><strong>{dayLabels[day].date}</strong></span>
                    <span className="journey-chain-content">{items.length ? <><span className="journey-day-dot"/><span className="journey-chain-title">{items[0].title}</span>{items.length > 1 && <span className="journey-chain-more">+{items.length - 1} more</span>}</> : <span className="journey-chain-pause" aria-hidden="true">—</span>}</span>
                  </button></li>;
                })}
              </ol>}</div>
            </section>; })}
            {!projectChains.length && <div className="journey-empty"><h3>No project activity in this period.</h3><p>Choose another person or project to explore their recorded work.</p></div>}
          </div> : weekStarts.map(start => <div className="journey-week" key={start}><div className="journey-week-heading"><span>WEEK {start / 7 + 1}</span><span>{formatDate(start, {day: 'numeric', month: 'short'})} — {formatDate(start + 6, {day: 'numeric', month: 'short'})}</span></div><ol className="journey-days" start={start + 1}>
            {days.slice(start, start + 7).map((_, offset) => {
              const day = start + offset;
              const items = byDay[day];
              const peers = [...new Set(items.map(item => people[item.person]))];
              return <li key={day}><button className={`journey-day${selectedDay === day ? ' selected' : ''}${items.length ? '' : ' quiet'}`} aria-label={`${formatDate(day, {month: 'long', day: 'numeric'})}: ${items.length ? items.map(item => item.title).join('; ') : 'No recorded activity'}`} aria-pressed={selectedDay === day} aria-controls="journey-day-details" onClick={() => selectDay(day)}>
                <span className="journey-day-date"><span>{formatDate(day, {weekday: 'short'})}</span><strong>{formatDate(day, {day: '2-digit'})}</strong></span>
                <span className="journey-day-dot"/>
                <span className="journey-day-title">{items[0]?.title || 'No recorded activity'}</span>
                <span className="journey-day-footer">{items.length ? <><span>{peers[0].split(' ')[0]}{peers.length > 1 ? ` +${peers.length - 1}` : ''}</span><span className="journey-more">{items.length > 1 ? `+${items.length - 1} more` : <Icon name="arrow"/>}</span></> : <span>A quiet day</span>}</span>
              </button></li>;
            })}
          </ol></div>)}

          <div className="journey-map-footer"><span><i/> A day of recorded work</span><span>Select any day to see the details <Icon name="arrow"/></span></div>
        </section>

        <aside id="journey-day-details" className="journey-details" aria-label="Selected day details">
          <div className="journey-details-header"><span className="journey-eyebrow">A CLOSER LOOK</span><div className="journey-day-navigation"><button aria-label="Previous day" disabled={selectedDay === 0} onClick={() => setSelectedDay(day => day - 1)}><span className="journey-back"><Icon name="chevron"/></span></button><button aria-label="Next day" disabled={selectedDay === 13} onClick={() => setSelectedDay(day => day + 1)}><Icon name="chevron"/></button></div></div>
          <div className="journey-selected-date" aria-live="polite" aria-atomic="true"><p>{formatDate(selectedDay, {weekday: 'long'})}</p><h2>{formatDate(selectedDay, {month: 'long', day: 'numeric'})}<span>, 2026</span></h2><p>{view === 'person' && detailProject ? `${projects[detailProject]} · ` : ''}{selected.length ? `${selected.length} ${selected.length === 1 ? 'outcome' : 'outcomes'}${view === 'project' ? ` across ${groups.length} ${groups.length === 1 ? 'contributor' : 'contributors'}` : ''}` : `No recorded activity for ${subject} with these filters.`}</p></div>
          <div className="journey-detail-groups" key={`${view}-${person}-${project}-${filter}-${selectedDay}-${detailProject}`}>
            {groups.length ? groups.map(group => <section className="journey-detail-group" key={group.name}><h3><span className="journey-group-mark" aria-hidden="true">{view === 'person' ? group.name[0] : initials(group.name)}</span>{group.name}<span className="journey-group-count">{group.items.length}</span></h3>{group.items.map(item => <article className="journey-outcome" key={item.title}><h4>{item.title}</h4><p>{item.detail}</p><details><summary><Icon name="commit"/><span>Supporting activity</span><span className="journey-evidence-count">{item.evidence.length}</span></summary><ul>{item.evidence.map(message => <li key={message}><Icon name="commit"/><span>{message}</span></li>)}</ul></details></article>)}</section>) : <div className="journey-empty"><Icon name="journey"/><h3>Room between the milestones.</h3><p>There is no recorded work for this day in the selected view. Choose another day to keep exploring.</p></div>}
          </div>
          <div className="journey-details-note"><span/> Illustrative outcomes and supporting activity.</div>
        </aside>
      </div>
      <footer className="journey-page-footer"><span>Small steps. A clearer picture.</span><span>Design preview · Sample data · No live workspace changes</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<JourneyPreview/>);
