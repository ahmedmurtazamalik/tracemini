import {type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import {formatInTimezone, TIMEZONE_OPTIONS} from './timezone.js';
import {InfoTip} from './help.js';

type Api = (path: string, options?: RequestInit) => Promise<any>;

function useAlive() {
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  return alive;
}

export function InvitationInbox({api, invitations, loadError, onClose, onChanged}: {api: Api; invitations: any[]; loadError?: string; onClose: () => void; onChanged: () => Promise<void>}) {
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState('');
  const alive = useAlive();
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'));
    if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
  };
  const act = async (id: string, action: 'accept' | 'decline') => {
    setPendingId(id); setError('');
    try {
      await api(`/invitations/${id}/${action}`, {method: 'POST'});
      if (!alive.current) return;
      await onChanged();
    } catch (caught: any) { if (alive.current) setError(caught.message); }
    finally { if (alive.current) setPendingId(undefined); }
  };
  const pending = invitations.filter(item => item.status === 'PENDING');
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="dialog invite-inbox" role="dialog" aria-modal="true" aria-labelledby="invite-inbox-heading" onKeyDown={handleDialogKeyDown}>
      <div className="section-heading"><div><span>Collaboration</span><h2 id="invite-inbox-heading">Invitation inbox</h2></div><button className="button secondary" onClick={onClose}>Close</button></div>
      {(error || loadError) && <div className="alert error" role="alert">{error || loadError}</div>}
      {!pending.length && <div className="empty-state"><span>✓</span><h3>You are caught up</h3><p>No pending workspace invitations.</p></div>}
      <div className="invite-list">
        {pending.map(invite => <article className="invite-row" key={invite.id}>
          <div><strong>{invite.workspace_name}</strong><small>Invited by {invite.invited_by_name} · {invite.role} access · expires {new Date(invite.expires_at).toLocaleDateString()}</small></div>
          <div className="actions"><button className="button primary" disabled={pendingId === String(invite.id)} onClick={() => void act(String(invite.id), 'accept')}>Accept</button><button className="button secondary" disabled={pendingId === String(invite.id)} onClick={() => void act(String(invite.id), 'decline')}>Decline</button></div>
        </article>)}
      </div>
    </section>
  </div>;
}

export function WorkspaceInvitations({api, workspaceId}: {api: Api; workspaceId: number}) {
  const [invitations, setInvitations] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Developer');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useAlive();
  const loadGeneration = useRef(0);
  const load = async () => {
    const generation = ++loadGeneration.current;
    try { const rows = await api(`/workspaces/${workspaceId}/invitations`); if (alive.current && generation === loadGeneration.current) setInvitations(rows); }
    catch (caught: any) { if (alive.current && generation === loadGeneration.current) setError(caught.message); }
  };
  useEffect(() => { setInvitations([]); setError(''); void load(); return () => { loadGeneration.current += 1; }; }, [workspaceId]);
  const send = async (event: FormEvent) => {
    const generation = loadGeneration.current;
    event.preventDefault(); setPending(true); setError(''); setMessage('');
    try {
      await api(`/workspaces/${workspaceId}/invitations`, {method: 'POST', body: JSON.stringify({email, role})});
      if (!alive.current || generation !== loadGeneration.current) return;
      setEmail(''); setMessage('Invitation sent. Access is granted only after acceptance.'); await load();
    } catch (caught: any) { if (alive.current && generation === loadGeneration.current) setError(caught.message); }
    finally { if (alive.current && generation === loadGeneration.current) setPending(false); }
  };
  const revoke = async (id: string) => { const generation = loadGeneration.current; setPending(true); setError(''); try { await api(`/workspaces/${workspaceId}/invitations/${id}`, {method: 'DELETE'}); if (generation === loadGeneration.current) await load(); } catch (caught: any) { if (alive.current && generation === loadGeneration.current) setError(caught.message); } finally { if (alive.current && generation === loadGeneration.current) setPending(false); } };
  return <section className="card settings-card workspace-invitations">
    <div className="section-heading"><div><span>Invitation inbox</span><h2>Invite a teammate</h2></div></div>
    <p className="muted">The teammate must already have a TraceMini account. They receive a private inbox invitation and get no access until they accept.</p>
    <form className="invite-form" onSubmit={send}>
      <label>Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="developer@example.com" /></label>
      <label>Role<select value={role} onChange={event => setRole(event.target.value)}><option>Developer</option><option>Manager</option></select></label>
      <button className="button primary" disabled={pending} type="submit">{pending ? 'Sending…' : 'Send invitation'}</button>
    </form>
    {message && <div className="alert success" role="status">{message}</div>}{error && <div className="alert error" role="alert">{error}</div>}
    <div className="invite-list">
      {invitations.map(invite => <article className="invite-row" key={invite.id}><div><strong>{invite.recipient_name}</strong><small>{invite.recipient_email} · {invite.role} · {invite.status.toLowerCase()}</small></div>{invite.status === 'PENDING' && <button className="button secondary" disabled={pending} onClick={() => void revoke(String(invite.id))}>Revoke</button>}</article>)}
      {!invitations.length && <p className="muted">No invitations sent yet.</p>}
    </div>
  </section>;
}

const weekdays = [{id: 1, label: 'Mon'}, {id: 2, label: 'Tue'}, {id: 3, label: 'Wed'}, {id: 4, label: 'Thu'}, {id: 5, label: 'Fri'}, {id: 6, label: 'Sat'}, {id: 7, label: 'Sun'}];

export function ReportSchedule({api, workspaceId, timezone}: {api: Api; workspaceId: number; timezone: string}) {
  const [schedule, setSchedule] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState('Scheduled workspace report');
  const [enabled, setEnabled] = useState(true);
  const [frequency, setFrequency] = useState('WEEKDAYS');
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [localTime, setLocalTime] = useState('09:00');
  const [zone, setZone] = useState(timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [reporter, setReporter] = useState('hermes');
  const [format, setFormat] = useState('summary');
  const [includeDiff, setIncludeDiff] = useState(false);
  const [notifySlack, setNotifySlack] = useState(false);
  const [windowDays, setWindowDays] = useState(7);
  const [nextRun, setNextRun] = useState<string>();
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const alive = useAlive();
  const loadGeneration = useRef(0);
  useEffect(() => {
    const generation = ++loadGeneration.current;
    setError(''); setMessage(''); setLoading(true); setNextRun(undefined);
    api(`/workspaces/${workspaceId}/report-schedule`).then((schedule: any) => {
      if (!alive.current || generation !== loadGeneration.current) return;
      setSchedule(schedule); setEditing(!schedule); setConfirmingDelete(false);
      if (!schedule) { setName('Scheduled workspace report'); setEnabled(true); setFrequency('WEEKDAYS'); setSelectedDays([]); setLocalTime('09:00'); setZone(timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); setReporter('hermes'); setFormat('summary'); setIncludeDiff(false); setNotifySlack(false); setWindowDays(7); return; }
      setName(schedule.name || 'Scheduled workspace report'); setEnabled(Boolean(schedule.enabled)); setFrequency(schedule.frequency); setSelectedDays(schedule.selected_days || []); setLocalTime(schedule.local_time); setZone(schedule.timezone); setReporter(schedule.reporter); setFormat(schedule.format); setIncludeDiff(Boolean(schedule.include_diff)); setNotifySlack(Boolean(schedule.notify_slack)); setWindowDays(Number(schedule.window_days)); setNextRun(schedule.next_run_at);
    }).catch((caught: any) => { if (alive.current && generation === loadGeneration.current) setError(caught.message); })
      .finally(() => { if (alive.current && generation === loadGeneration.current) setLoading(false); });
    return () => { loadGeneration.current += 1; };
  }, [workspaceId]);
  const nextLabel = useMemo(() => nextRun ? formatInTimezone(nextRun, zone) : undefined, [nextRun, zone]);
  const save = async (event: FormEvent) => {
    const generation = loadGeneration.current;
    event.preventDefault(); setPending(true); setError(''); setMessage('');
    try {
      const schedule = await api(`/workspaces/${workspaceId}/report-schedule`, {method: 'PUT', body: JSON.stringify({name, enabled, frequency, selectedDays, localTime, timezone: zone, reporter, format, includeDiff, notifySlack, windowDays})});
      if (!alive.current || generation !== loadGeneration.current) return; setSchedule(schedule); setName(schedule.name); setNextRun(schedule.next_run_at); setEditing(false); setMessage(enabled ? 'Schedule saved.' : 'Schedule paused.');
    } catch (caught: any) { if (alive.current && generation === loadGeneration.current) setError(caught.message); }
    finally { if (alive.current && generation === loadGeneration.current) setPending(false); }
  };
  const remove = async () => {
    const generation = loadGeneration.current;
    setPending(true); setError(''); setMessage('');
    try {
      await api(`/workspaces/${workspaceId}/report-schedule`, {method: 'DELETE'});
      if (!alive.current || generation !== loadGeneration.current) return;
      setSchedule(null); setName('Scheduled workspace report'); setEnabled(true); setFrequency('WEEKDAYS'); setSelectedDays([]); setLocalTime('09:00'); setReporter('hermes'); setFormat('summary'); setIncludeDiff(false); setNotifySlack(false); setWindowDays(7); setNextRun(undefined); setEditing(true); setConfirmingDelete(false); setMessage('Schedule deleted.');
    } catch (caught: any) { if (alive.current && generation === loadGeneration.current) setError(caught.message); }
    finally { if (alive.current && generation === loadGeneration.current) setPending(false); }
  };
  return <section className="card reports-create-card schedule-card">
    <div className="section-heading"><div><span>Automatic reports</span><h2 className="heading-with-tip">Schedule workspace reports <InfoTip label="Scheduled reports">A connected Manager device claims due jobs and runs the selected local AI generator. If it was offline, the latest missed window is recovered when it reconnects.</InfoTip></h2></div></div>
    <p className="muted">Reports are queued at your selected local time and generated by your connected TraceMini device. Scheduled reports cover the whole workspace.</p>
    {loading ? <div className="alert progress" role="status">Loading schedule…</div> : schedule && !editing ? <div className="saved-schedule">
      <div><strong>{schedule.name}</strong><small>{enabled ? 'Enabled' : 'Paused'} · {frequency === 'DAILY' ? 'Every day' : frequency === 'WEEKDAYS' ? 'Weekdays' : selectedDays.map(day => weekdays.find(item => item.id === day)?.label).join(', ')} at {localTime} ({zone})</small>{nextLabel && enabled && <small>Next report: {nextLabel}</small>}</div>
      <div className="actions"><button className="button secondary" type="button" onClick={() => { setEditing(true); setConfirmingDelete(false); setMessage(''); }}>Edit schedule</button><button className="button danger-button" type="button" onClick={() => setConfirmingDelete(true)}>Delete schedule</button></div>
      {confirmingDelete && <div className="alert error schedule-delete-confirm" role="alert"><span>Delete this schedule? Existing generated reports will be kept.</span><div className="actions"><button className="button secondary" disabled={pending} type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button><button className="button danger-button" disabled={pending} type="button" onClick={() => void remove()}>{pending ? 'Deleting…' : 'Delete schedule'}</button></div></div>}
    </div> : <form className="reports-controls" onSubmit={save}>
      <label className="span-two">Scheduled report name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Example: Leadership delivery brief" /></label>
      <label>Schedule<select value={enabled ? 'enabled' : 'paused'} onChange={event => setEnabled(event.target.value === 'enabled')}><option value="enabled">Enabled</option><option value="paused">Paused</option></select></label>
      <label>Frequency<select value={frequency} onChange={event => setFrequency(event.target.value)}><option value="DAILY">Every day</option><option value="WEEKDAYS">Weekdays</option><option value="SELECTED_DAYS">Selected days</option></select></label>
      {frequency === 'SELECTED_DAYS' && <fieldset className="weekday-picker span-two"><legend>Run on</legend>{weekdays.map(day => <label key={day.id}><input type="checkbox" checked={selectedDays.includes(day.id)} onChange={() => setSelectedDays(current => current.includes(day.id) ? current.filter(item => item !== day.id) : [...current, day.id].sort())} />{day.label}</label>)}</fieldset>}
      <label>Local time<input required type="time" value={localTime} onChange={event => setLocalTime(event.target.value)} /></label>
      <label>Timezone<select required value={zone} onChange={event => setZone(event.target.value)}>{!TIMEZONE_OPTIONS.some(option => option.value === zone) && <option value={zone}>{zone}</option>}{TIMEZONE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label><span className="label-with-tip">Evidence window <InfoTip label="Evidence window">How many calendar days of workspace activity each scheduled report summarizes.</InfoTip></span><select value={windowDays} onChange={event => setWindowDays(Number(event.target.value))}><option value={1}>Previous day</option><option value={7}>Previous 7 days</option><option value={14}>Previous 14 days</option><option value={30}>Previous 30 days</option></select></label>
      <label><span className="label-with-tip">Generator <InfoTip label="Scheduled report generator">Runs on the connected Manager device, where the selected tool must already be installed and authenticated.</InfoTip></span><select value={reporter} onChange={event => setReporter(event.target.value)}><option value="hermes">Hermes</option><option value="codex">Codex</option></select></label>
      <label>Writing style<select value={format} onChange={event => setFormat(event.target.value)}><option value="summary">Bullet-point summary</option><option value="detailed">Detailed report</option></select></label>
      <label className="diff-consent"><input type="checkbox" checked={includeDiff} onChange={event => setIncludeDiff(event.target.checked)} /><span><strong>Share bounded diff excerpts</strong><small>Add redacted code excerpts for better detail.</small></span></label>
      <label className="diff-consent"><input type="checkbox" checked={notifySlack} onChange={event => setNotifySlack(event.target.checked)} /><span><strong>Notify Slack</strong><small>Post the full report when it is ready.</small></span></label>
      <div className="actions span-two"><button className="button primary" disabled={pending || (frequency === 'SELECTED_DAYS' && !selectedDays.length)} type="submit">{pending ? 'Saving…' : schedule ? 'Save changes' : 'Create schedule'}</button>{schedule && <button className="button secondary" disabled={pending} type="button" onClick={() => setEditing(false)}>Cancel</button>}</div>
    </form>}
    {message && <div className="alert success" role="status">{message}</div>}{error && <div className="alert error" role="alert">{error}</div>}
  </section>;
}
