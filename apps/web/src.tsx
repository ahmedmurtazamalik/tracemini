import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  getRouteContext,
  getRouteView,
  reportMatchesRoute,
  workspacePath,
} from "./routes.js";
import { checkCliConnection, deviceManagementAction } from "./device-connection.js";
import { reportJobProgress, type ReportJob } from "./report-progress.js";
import { TIMEZONE_OPTIONS, formatInTimezone, normalizeTimezone, todayInTimezone } from "./timezone.js";
import { applyTheme, nextTheme, normalizeTheme, THEME_STORAGE_KEY, themeToggleLabel, type Theme } from "./theme.js";
import { waitForReportJob } from "./report-jobs.js";
import { canApplyWorkspaceResult } from "./async-state.js";
import { workspaceLoadPlan, type WorkspaceLoadKey } from "./workspace-loading.js";
import { repositorySelectionState, type RepositoryCandidate } from "./repository-selection.js";
import { InvitationInbox, ReportSchedule, WorkspaceInvitations } from "./collaboration.js";
import "./style.css";

const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(localStorage.token
        ? { authorization: `Bearer ${localStorage.token}` }
        : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new Error(
      result?.error ||
        result?.message ||
        "TraceMini could not complete the request.",
    );
  return result;
};
const ReportMarkdown = React.lazy(async () => {
  const [{default: ReactMarkdown}, {default: remarkGfm}] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
  ]);
  return {default: ({markdown}: {markdown: string}) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
  )};
});
const navigate = (path: string) => {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};
const initialTimezone = () => normalizeTimezone(localStorage.getItem("timezone"));

function Brand() {
  return (
    <span className="brand-lockup">
      <span className="brand-mark" aria-hidden="true">
        T
      </span>
      <span>
        TraceMini<small>Developer activity</small>
      </span>
    </span>
  );
}

function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <button
          className="auth-brand"
          onClick={() => navigate("/")}
          aria-label="TraceMini home"
        >
          <Brand />
        </button>
        <div className="auth-copy">
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {children}
        <p className="auth-note">
          Self-hosted activity data stays in your TraceMini database. Source
          code stays on developer machines.
        </p>
      </section>
      <aside className="auth-aside" aria-label="TraceMini overview">
        <div className="auth-grid" aria-hidden="true" />
        <div className="auth-signal" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="auth-message">
          <span />
          <h2>See the shape of the work, not just the commits.</h2>
          <p>
            TraceMini turns local Git signals into a clear, defensible narrative
            of progress.
          </p>
        </div>
        <dl>
          <div>
            <dt>Source</dt>
            <dd>Stays local</dd>
          </div>
          <div>
            <dt>Activity</dt>
            <dd>PostgreSQL metadata</dd>
          </div>
          <div>
            <dt>Reports</dt>
            <dd>Local AI context</dd>
          </div>
        </dl>
      </aside>
    </main>
  );
}

function Auth({
  onLogin,
  route,
}: {
  onLogin: (token: string) => void;
  route: string;
}) {
  const mode = route === "/register" ? "register" : "login";
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget));
      const result = await request(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      localStorage.token = result.token;
      onLogin(result.token);
      navigate("/");
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  };
  return (
    <AuthShell
      eyebrow="Secure developer workspace"
      title={mode === "login" ? "Welcome back." : "Create your account."}
      description={
        mode === "login"
          ? "Sign in to review your development activity."
          : "Start a private workspace for your team’s local Git activity."
      }
    >
      <form className="auth-form" onSubmit={submit}>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {mode === "register" && (
          <label>
            Name
            <input name="name" autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            minLength={8}
            required
          />
        </label>
        <button className="button primary" disabled={pending}>
          {pending
            ? <BusyIndicator label={mode === "login" ? "Signing in…" : "Creating account…"} />
            : mode === "login"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>
      <div className="auth-links">
        {mode === "login" ? (
          <button onClick={() => navigate("/register")}>
            Create an account
          </button>
        ) : (
          <button onClick={() => navigate("/")}>Back to sign in</button>
        )}
      </div>
    </AuthShell>
  );
}

function BusyIndicator({ label }: { label: string }) {
  return (
    <span className="busy-indicator" role="status">
      <i className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function ProgressTrack({ label }: { label: string }) {
  return (
    <span className="progress-track" role="progressbar" aria-label={label} aria-valuetext={label}>
      <i aria-hidden="true" />
    </span>
  );
}

function LoadingSurface({label, detail, fullScreen = false}: {label: string; detail: string; fullScreen?: boolean}) {
  return (
    <div className={fullScreen ? "loading-surface full-screen" : "loading-surface"} role="status" aria-live="polite" aria-busy="true">
      <Brand />
      <span className="loading-spinner" aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
      <ProgressTrack label={label} />
    </div>
  );
}

function ThemeToggle({theme, onToggle, floating = false}: {theme: Theme; onToggle: () => void; floating?: boolean}) {
  const night = theme === "night";
  return (
    <button
      className={`theme-toggle${floating ? " floating" : ""}`}
      type="button"
      aria-label={themeToggleLabel(theme)}
      aria-pressed={night}
      title={themeToggleLabel(theme)}
      onClick={onToggle}
    >
      <span aria-hidden="true">{night ? "☀" : "☾"}</span>
      <strong>{night ? "Day" : "Night"}</strong>
    </button>
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(value);
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed. Select and copy the command manually.");
}

function useActiveView() {
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  return active;
}

function Install({ workspaceId, agents, userId, onAgentsChecked }: { workspaceId: number; agents: any[]; userId: number; onAgentsChecked: (agents: any[]) => void }) {
  const active = useActiveView();
  const [installation, setInstallation] = useState<any>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [checkPending, setCheckPending] = useState(false);
  const [checkMessage, setCheckMessage] = useState("");
  const [copied, setCopied] = useState("");
  const [copyPending, setCopyPending] = useState("");
  const personalDevices = agents.filter((agent) => agent.user_id === userId && !agent.revoked_at);
  const onlineDevices = personalDevices.filter((agent) => agent.status === "online");
  const checkConnection = async () => {
    setError("");
    setCheckMessage("");
    setCheckPending(true);
    try {
      const result = await checkCliConnection(workspaceId, userId, request);
      if (!active.current) return;
      onAgentsChecked(result.agents);
      setCheckMessage(
        result.state === "connected"
          ? `${result.machineNames.join(", ")} ${result.machineNames.length === 1 ? "is" : "are"} connected.`
          : result.state === "offline"
            ? `CLI found on ${result.machineNames.join(", ")}, but it is offline.`
            : "No CLI device was found for your account in this workspace.",
      );
    } catch (caught: any) {
      if (active.current) setError(caught.message || "Could not check the CLI connection.");
    } finally {
      if (active.current) setCheckPending(false);
    }
  };
  const mint = async () => {
    setError("");
    setPending(true);
    try {
      const nextInstallation = await request("/agents/installations", {
          method: "POST",
          body: JSON.stringify({ workspaceId }),
        });
      if (active.current) setInstallation(nextInstallation);
    } catch (caught: any) {
      if (active.current) setError(caught.message);
    } finally {
      if (active.current) setPending(false);
    }
  };
  const Copy = ({ command, label }: { command: string; label: string }) => (
    <div className="command">
      <div>
        <small>{label}</small>
        <pre>{command}</pre>
      </div>
      <button
        className="button secondary"
        disabled={Boolean(copyPending)}
        onClick={async () => {
          setError("");
          setCopyPending(label);
          try {
            await copyText(command);
            setCopied(label);
          } catch (caught: any) {
            setError(caught.message || "Could not copy the command.");
          } finally {
            setCopyPending("");
          }
        }}
      >
        {copyPending === label ? <BusyIndicator label="Copying…" /> : copied === label ? "Copied" : "Copy"}
      </button>
    </div>
  );
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Local device"
        title="Install TraceMini CLI"
        description="Connect this Linux device once to your account. Repositories and reports remain workspace-scoped, and source code stays local."
      />
      <section className="card device-detection" aria-live="polite">
        <span>CLI connection</span>
        <h2>{onlineDevices.length ? "CLI connected" : personalDevices.length ? "CLI installed, device offline" : "CLI not detected"}</h2>
        <p className="muted">
          {onlineDevices.length
            ? `${onlineDevices.map((device) => device.machine_name).join(", ")} ${onlineDevices.length === 1 ? "is" : "are"} connected to your account and available in this workspace.`
            : personalDevices.length
              ? `TraceMini was installed on ${personalDevices.map((device) => device.machine_name).join(", ")}, but no heartbeat was received in the last minute.`
              : "No TraceMini device has connected to your account yet."}
        </p>
        <button className="button secondary" onClick={checkConnection} disabled={checkPending}>
          {checkPending ? "Checking…" : "Check CLI connection"}
        </button>
        {checkMessage && <p className="muted" role="status">{checkMessage}</p>}
      </section>
      <section className="card install-card">
        <div className="step-number">01</div>
        <div>
          <h2>Connect or sync this device</h2>
          <p>
            The command expires after 10 minutes and works once. If TraceMini is already installed, it updates and securely reconnects that installation to this account. Otherwise, it performs the first installation—no sudo or npm registry required.
          </p>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {!installation ? (
            <button
              className="button primary"
              onClick={mint}
              disabled={pending}
            >
              {pending
                ? <BusyIndicator label="Preparing connection…" />
                : personalDevices.length
                  ? "Connect another device"
                  : "Connect or sync this device"}
            </button>
          ) : (
            <>
              <div className="alert progress" role="status">
                Run this command on the device. It installs or updates the CLI, safely connects it to this account, and keeps your watched folders.
              </div>
              <Copy label="Connect or sync command" command={installation.syncCommand || installation.installCommand} />
            </>
          )}
        </div>
      </section>
      {installation && (
        <section className="card install-card">
          <div className="step-number">02</div>
          <div>
            <h2>Verify the device</h2>
            <p>
              The page checks for a heartbeat every five seconds. Open a new terminal after connecting, then run these checks.
            </p>
            <Copy
              label="Add TraceMini to PATH"
              command={'export PATH="$HOME/.local/bin:$PATH"'}
            />
            <Copy label="Find the command" command="command -v tracemini" />
            <Copy label="Check device status" command="tracemini status" />
            <Copy
              label="Register repository folders"
              command={'tracemini watch "$HOME/path-to-repositories"'}
            />
            <Copy
              label="Import existing Git history when convenient"
              command="tracemini sync-history --days 90"
            />
            <Copy
              label="Check system service"
              command="systemctl --user status tracemini.service --no-pager"
            />
            <p className="muted">
              Install command expires at{" "}
              {new Date(installation.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function Trend({ daily }: { daily: any[] }) {
  const max = Math.max(1, ...daily.map((day) => day.commits));
  return (
    <div className="trend" aria-label="Daily commit trend" role="list">
      {daily.length ? (
        daily.map((day) => (
          <div
            role="listitem"
            aria-label={`${day.date}: ${day.commits} commits`}
            title={`${day.date}: ${day.commits} commits`}
            key={day.date}
          >
            <i
              aria-hidden="true"
              style={{ height: `${Math.max(8, (day.commits / max) * 100)}%` }}
            />
            <small>{day.date.slice(5)}</small>
          </div>
        ))
      ) : (
        <p className="empty-inline">Commit activity will appear here.</p>
      )}
    </div>
  );
}

function Activity({
  events,
  workspaceId,
  timezone,
}: {
  events: any[];
  workspaceId: number;
  timezone: string;
}) {
  return (
    <section className="card activity-card">
      <div className="section-heading">
        <div>
          <span>Timeline</span>
          <h2>Recent activity</h2>
        </div>
        <span className="count-badge">{events.length}</span>
      </div>
      {events.length ? (
        events.map((event) => (
          <article className="event" key={event.id}>
            <div className="event-dot" />
            <div>
              <div className="event-meta">
                <button
                  className="inline"
                  onClick={() =>
                    navigate(
                      `/workspaces/${workspaceId}/users/${event.user_id}`,
                    )
                  }
                >
                  {event.user_name}
                </button>
                <span>in</span>
                <button
                  className="inline"
                  onClick={() =>
                    navigate(
                      `/workspaces/${workspaceId}/repositories/${event.repository_id}`,
                    )
                  }
                >
                  {event.repository_name}
                </button>
              </div>
              <p>
                <strong>{event.type}</strong>{" "}
                {event.data.message || event.data.branch || ""}
                {event.type === "push" &&
                  ` · ${event.data.confirmation || "unconfirmed"}`}
              </p>
              <time>{formatInTimezone(event.occurred_at, timezone)}</time>
            </div>
          </article>
        ))
      ) : (
        <EmptyState
          title="No activity yet"
          text="Install the CLI and watch a Git root to start collecting local development signals."
        />
      )}
    </section>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">+</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function RepositorySelection({workspaceId, candidates, agents, userId, canManage, reload}: {workspaceId: number; candidates: RepositoryCandidate[]; agents: any[]; userId: number; canManage: boolean; reload: () => Promise<void>}) {
  const [changing, setChanging] = useState<number>();
  const [scanning, setScanning] = useState(false);
  const [scanPolling, setScanPolling] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const active = () => canApplyWorkspaceResult(workspaceId, workspaceId, mounted.current);
  useEffect(() => () => { mounted.current = false; }, []);
  const hasPending = scanPolling || candidates.some(candidate => candidate.desired_traced !== candidate.traced && !candidate.error);
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void reload(), 2_000);
    return () => clearInterval(timer);
  }, [hasPending, reload]);
  useEffect(() => {
    if (!scanPolling) return;
    const timer = setTimeout(() => setScanPolling(false), 30_000);
    return () => clearTimeout(timer);
  }, [scanPolling]);
  const ownAgents = agents.filter(agent => Number(agent.user_id) === Number(userId) && agent.status !== "revoked");
  return <section className="card settings-card repository-selection-card">
    <span>Local Git discovery</span><h2>Repository proposals</h2>
    <p className="muted">Scan only folders you previously approved with <code>tracemini watch</code>. The device sends bounded repository metadata here; no hooks or history import starts until a Manager approves tracing.</p>
    <button className="button secondary" disabled={scanning || ownAgents.length === 0} onClick={async () => {
      setScanning(true); setError(""); setMessage("");
      try {
        for (const agent of ownAgents) await request(`/workspaces/${workspaceId}/repository-scans`, {method: "POST", body: JSON.stringify({agentId: agent.id})});
        if (!active()) return;
        setMessage(`Scan requested on ${ownAgents.length} device${ownAgents.length === 1 ? "" : "s"}. New repositories will appear as proposals.`);
        setScanPolling(true);
        await reload();
      } catch (caught: any) { if (active()) setError(caught.message); }
      finally { if (active()) setScanning(false); }
    }}>{scanning ? <BusyIndicator label="Requesting scan…" /> : "Scan repositories on my devices"}</button>
    {ownAgents.length === 0 && <p className="muted">Install or reconnect the TraceMini device agent before scanning.</p>}
    {message && <div className="alert success" role="status">{message}</div>}
    {error && <div className="alert error" role="alert">{error}</div>}
    {candidates.length ? candidates.map(candidate => {
      const state = repositorySelectionState(candidate);
      return <label className="repository-choice" key={candidate.id}>
        <span><strong>{candidate.name}</strong><small>{candidate.owner_name ? `${candidate.owner_name} · ` : ""}{candidate.machine_name} · {candidate.branch || "detached"}</small>{candidate.local_key && <code>{candidate.local_key}</code>}{candidate.error && <small className="error-text">{candidate.error}</small>}</span>
        <span className={`selection-state ${state.tone}`}>
          {changing === candidate.id
            ? <><BusyIndicator label="Saving selection…" /><ProgressTrack label={`Saving ${candidate.name} selection`} /></>
            : state.pending
              ? <><BusyIndicator label={state.label} /><ProgressTrack label={`${state.label} ${candidate.name}`} /></>
              : candidate.traced || candidate.error ? state.label : canManage ? "Awaiting approval" : "Awaiting Manager approval"}
        </span>
        <input type="checkbox" role="switch" aria-label={`${canManage ? "Approve tracing" : "Tracing approval"} for ${candidate.name} on ${candidate.machine_name}`} checked={state.checked} disabled={!canManage || state.pending || changing === candidate.id} onChange={async event => {
          setChanging(candidate.id); setError("");
          try { await request(`/workspaces/${workspaceId}/repository-candidates/${candidate.id}`, {method: "PATCH", body: JSON.stringify({traced: event.target.checked})}); if (active()) await reload(); }
          catch (caught: any) { if (active()) setError(caught.message); }
          finally { if (active()) setChanging(undefined); }
        }} />
      </label>;
    }) : <p className="muted">No proposals yet. Request a scan after configuring an approved folder on your device.</p>}
  </section>;
}

function Settings({ workspace, members, repositories, agents, repositoryCandidates, reload, reloadCandidates, userId }: any) {
  const active = useActiveView();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const mutate = async (path: string, method = "POST", body?: any) => {
    setError("");
    setMessage("");
    setPending(true);
    try {
      await request(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!active.current) return;
      await reload();
      if (active.current) setMessage("Workspace updated.");
    } catch (caught: any) {
      if (active.current) setError(caught.message);
    } finally {
      if (active.current) setPending(false);
    }
  };
  if (workspace.role !== "Manager")
    return (
      <div className="page-stack">
        <PageHeading
          eyebrow="Workspace overview"
          title={`${workspace.name} details`}
          description="View the people and repositories in this workspace. Managers control changes."
        />
        <div className="alert progress" role="status">
          Managers approve workspace tracing. You can scan approved folders on your own devices and review their proposal status here.
        </div>
        <div className="settings-grid">
          <RepositorySelection workspaceId={workspace.id} candidates={repositoryCandidates} agents={agents} userId={userId} canManage={false} reload={reloadCandidates} />
          <section className="card settings-card">
            <span>People</span>
            <h2>Members</h2>
            {members.length ? members.map((member: any) => (
              <div className="row" key={member.id}>
                <span><strong>{member.name}</strong><small>{member.email}</small></span>
                <strong>{member.role}</strong>
              </div>
            )) : <p className="muted">No members found.</p>}
          </section>
          <section className="card settings-card">
            <span>Code</span>
            <h2>Repositories</h2>
            {repositories.length ? repositories.map((repository: any) => (
              <div className="row" key={repository.id}>
                <span><strong>{repository.name}</strong><small>{repository.normalized_remote}</small></span>
              </div>
            )) : <p className="muted">No repositories registered.</p>}
          </section>
        </div>
      </div>
    );
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Workspace administration"
        title={`${workspace.name} settings`}
        description="Manage members, invites, repositories, and local devices for this workspace."
      />
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {pending && (
        <div className="alert progress" role="status">
          <BusyIndicator label="Updating workspace…" />
        </div>
      )}
      {message && (
        <div className="alert success" role="status">
          {message}
        </div>
      )}
      <div className="settings-grid" aria-busy={pending}>
        <RepositorySelection workspaceId={workspace.id} candidates={repositoryCandidates} agents={agents} userId={userId} canManage={true} reload={reloadCandidates} />
        <section className="card settings-card">
          <span>People</span>
          <h2>Members</h2>
          {members.map((member: any) => (
            <div className="row" key={member.id}>
              <span>
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </span>
              <select
                aria-label={`Role for ${member.name}`}
                value={member.role}
                onChange={(event) =>
                  mutate(
                    `/workspaces/${workspace.id}/members/${member.id}`,
                    "PATCH",
                    { role: event.target.value },
                  )
                }
              >
                <option>Manager</option>
                <option>Developer</option>
              </select>
              <button
                className="button secondary"
                onClick={() =>
                  mutate(
                    `/workspaces/${workspace.id}/members/${member.id}`,
                    "DELETE",
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
        </section>
        <WorkspaceInvitations api={request} workspaceId={workspace.id} />
        <section className="card settings-card">
          <span>Sources</span>
          <h2>Repositories</h2>
          {repositories.length ? (
            repositories.map((repo: any) => (
              <div className="row" key={repo.id}>
                <span>
                  <strong>{repo.name}</strong>
                  <small>{repo.archived ? "Archived" : "Active"}</small>
                </span>
                <button
                  className="button secondary"
                  onClick={() =>
                    mutate(
                      `/workspaces/${workspace.id}/repositories/${repo.id}`,
                      "PATCH",
                      { archived: !repo.archived },
                    )
                  }
                >
                  {repo.archived ? "Unarchive" : "Archive"}
                </button>
              </div>
            ))
          ) : (
            <p className="muted">No repositories have been discovered yet.</p>
          )}
        </section>
        <section className="card settings-card">
          <span>Machines</span>
          <h2>Devices</h2>
          <p className="muted">Account devices for current workspace members. You can revoke only your own device, which disconnects it from every workspace.</p>
          {agents.length ? (
            agents.map((agent: any) => (
              <div className="row" key={agent.id}>
                <span>
                  <strong>
                    <i className={`status ${agent.status}`} />{" "}
                    {agent.machine_name}
                  </strong>
                  <small>
                    {agent.user_name} · {agent.status}
                  </small>
                </span>
                {agent.user_id === userId && (() => {
                  const action = deviceManagementAction(agent, workspace.id);
                  return <button
                    className="button secondary"
                    onClick={() =>
                      (action.label !== "Remove" || confirm(`Remove revoked device ${agent.machine_name} from this website? Its historical activity will be preserved.`)) &&
                      (action.label !== "Revoke" || confirm(`Revoke ${agent.machine_name}? This disconnects the account device from every workspace.`)) &&
                      mutate(action.path, action.method)
                    }
                  >
                    {action.label}
                  </button>;
                })()}
              </div>
            ))
          ) : (
            <p className="muted">No devices installed.</p>
          )}
        </section>
        <section className="card settings-card danger">
          <span>Danger zone</span>
          <h2>Delete workspace</h2>
          <p>
            Permanent removal includes activity, reports, memberships, and device
            access.
          </p>
          <button
            className="button danger-button"
            onClick={() =>
              confirm("Permanently delete this workspace and its activity?") &&
              mutate(`/workspaces/${workspace.id}`, "DELETE")
            }
          >
            Delete workspace
          </button>
        </section>
      </div>
    </div>
  );
}

function WorkspaceRequired({
  openDialog,
}: {
  openDialog: () => void;
}) {
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Workspace setup"
        title="Connect your first workspace."
        description="CLI installation and settings belong to a workspace. Create one, or accept a team invitation from your inbox."
      />
      <section className="card onboarding-card">
        <div className="onboarding-icon" aria-hidden="true">
          01
        </div>
        <div>
          <h2>Create your workspace</h2>
          <p>
            If a Manager invited you to an existing workspace, use the invitation inbox in the top bar instead.
          </p>
          <div className="actions">
            <button
              className="button primary"
              onClick={openDialog}
            >
              Create workspace
            </button>

          </div>
        </div>
      </section>
    </div>
  );
}

function WorkspaceDialog({
  close,
  complete,
}: {
  close: () => void;
  complete: (workspaceId?: number) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || []),
      ];
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
      >
        <span className="eyebrow">Workspace setup</span>
        <h2 id="workspace-dialog-title">Create a workspace</h2>
        <p>Give your team workspace a clear name.</p>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError("");
            try {
              const values = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              const result = await request("/workspaces", { method: "POST", body: JSON.stringify(values) });
              await complete(result.id);
              close();
            } catch (caught: any) {
              setError(caught.message);
            } finally {
              setPending(false);
            }
          }}
        >
          <label>
            Workspace name
            <input autoFocus name="name" required />
          </label>
          <div className="actions">
            <button className="button secondary" type="button" onClick={close}>
              Cancel
            </button>
            <button className="button primary" disabled={pending}>
              {pending ? <BusyIndicator label="Creating workspace…" /> : "Create workspace"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Dashboard({
  workspaceId,
  route,
  dates,
  setDates,
  stats,
  events,
  repositories,
  reload,
  error,
  timezone,
}: any) {
  const [refreshPending, setRefreshPending] = useState(false);
  const activeView = useActiveView();
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Development activity"
        title={
          route.includes("/users/")
            ? "User activity"
            : route.includes("/repositories/")
              ? "Repository activity"
              : "Activity dashboard"
        }
        description="A focused view of commit evidence collected by local TraceMini devices."
      />
      <section className="dashboard-toolbar">
        <label>
          From
          <input
            type="date"
            value={dates.from}
            onChange={(event) =>
              setDates({ ...dates, from: event.target.value })
            }
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={dates.to}
            onChange={(event) => setDates({ ...dates, to: event.target.value })}
          />
        </label>
      </section>
      <div className="metrics">
        {[
          ["commits", "Commits"],
          ["filesChanged", "Files changed"],
          ["insertions", "Insertions"],
          ["deletions", "Deletions"],
        ].map(([key, label], index) => (
          <article className="card metric-card" key={key}>
            <span>0{index + 1}</span>
            <big>{stats.totals[key] || 0}</big>
            <small>{label}</small>
          </article>
        ))}
      </div>
      <Trend daily={stats.daily} />
      <div className="dashboard-grid">
        <Activity events={events} workspaceId={workspaceId} timezone={timezone} />
        <aside className="card insight-card">
          <div className="section-heading">
            <div>
              <span>Workspace</span>
              <h2>Repository signals</h2>
            </div>
          </div>
          <h3>Repositories</h3>
          {repositories
            .filter((repo: any) => !repo.archived)
            .map((repo: any) => (
              <button
                className="repo"
                key={repo.id}
                onClick={() =>
                  navigate(`/workspaces/${workspaceId}/repositories/${repo.id}`)
                }
              >
                <strong>{repo.name}</strong>
                <small>{repo.clone_count} local clone(s)</small>
              </button>
            ))}
          {!repositories.length && (
            <p className="muted">No repositories yet.</p>
          )}
          <button
            className="button secondary full"
            disabled={refreshPending}
            onClick={async () => {
              setRefreshPending(true);
              try { await reload(); } finally { if (activeView.current) setRefreshPending(false); }
            }}
          >
            {refreshPending ? <BusyIndicator label="Refreshing…" /> : "Refresh dashboard"}
          </button>
        </aside>
      </div>
      {refreshPending && (
        <div className="alert progress action-progress" role="status" aria-live="polite">
          <BusyIndicator label="Refreshing dashboard data…" />
          <span>Fetching activity, repository signals, and updated totals.</span>
          <ProgressTrack label="Refreshing dashboard data" />
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function ReportDetail({ report, workspaceId, currentUserId, reload }: any) {
  const [showRename, setShowRename] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [name, setName] = useState(report.name || "");
  const [reporter, setReporter] = useState("codex");
  const [format, setFormat] = useState(report.format || "detailed");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [regenerationStatus, setRegenerationStatus] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const operationScope = useRef({identity: `${workspaceId}:${report.id}`, generation: 0});
  const operationIdentity = `${workspaceId}:${report.id}`;
  if (operationScope.current.identity !== operationIdentity) {
    operationScope.current = {identity: operationIdentity, generation: operationScope.current.generation + 1};
  }
  useEffect(() => () => { operationScope.current.generation += 1; }, []);
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const operation = ++operationScope.current.generation;
    const active = () => operation === operationScope.current.generation;
    setPending(true);
    setMessage("");
    setError("");
    try {
      const updated = await request(`/reports/${report.id}`, {method: "PATCH", body: JSON.stringify({name})});
      if (!active()) return;
      setName(updated.name);
      setMessage("Report renamed successfully.");
      setShowRename(false);
      await reload();
    } catch (caught: any) {
      if (active()) setError(caught.message);
    } finally {
      if (active()) setPending(false);
    }
  };
  const regenerate = async (event: FormEvent) => {
    event.preventDefault();
    const operation = ++operationScope.current.generation;
    const active = () => operation === operationScope.current.generation;
    setPending(true);
    setRegenerationStatus("Queueing regeneration request…");
    setMessage("");
    setError("");
    try {
      const job = await request(`/reports/${report.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ reporter, prompt, format }),
      });
      if (!active()) return;
      setMessage("Regeneration queued. Waiting for the connected device…");
      setRegenerationStatus("Waiting for a connected device to claim the report…");
      const status = await waitForReportJob(
        job.id,
        (jobId) => request(`/reports/jobs/${jobId}`),
        {isActive: active, onStatus: (latest) => {
          if (!active()) return;
          setRegenerationStatus(latest.status === "running"
            ? "Generating the report on your connected device…"
            : "Waiting for a connected device to claim the report…");
        }},
      );
      if (!status) return;
      if (status.status === "completed") {
        setMessage("Report regenerated successfully.");
        setShowRegenerate(false);
        setPrompt("");
        await reload();
        return;
      }
      if (status.status === "failed")
        throw new Error(status.error || "Report regeneration failed.");
      setMessage("Regeneration is still processing. Refresh this report later to see the update.");
    } catch (caught: any) {
      if (active()) setError(caught.message);
    } finally {
      if (active()) { setPending(false); setRegenerationStatus(""); }
    }
  };
  return (
    <section className="card report">
      <div className="section-heading report-heading">
        <div><span>{report.report_scope === "workspace" ? "Workspace summary" : "Individual report"} · {report.user_name || "Unknown author"}</span><h1>{report.name || `${report.start_date} — ${report.end_date}`}</h1></div>
      </div>
      <div className="actions report-actions">
        <button className="button secondary" onClick={() => navigate(workspacePath(workspaceId, "reports"))}>
          ← Report history
        </button>
        <button className="button secondary" disabled={refreshPending} onClick={async () => {
          setRefreshPending(true);
          try { await reload(); } finally { setRefreshPending(false); }
        }}>
          {refreshPending ? <BusyIndicator label="Refreshing…" /> : "Refresh report"}
        </button>
        {report.user_id === currentUserId && (
          <>
            <button className="button secondary" onClick={() => setShowRename(!showRename)}>
              Rename
            </button>
            <button className="button secondary" onClick={() => setShowRegenerate(!showRegenerate)}>
              Regenerate
            </button>
          </>
        )}
        <button className="button primary" onClick={async () => (await import("./report-download.js")).downloadReport(report)}>
          Download .md
        </button>
      </div>
      {showRename && (
        <form className="reports-create-card" onSubmit={rename}>
          <div className="reports-controls">
            <label className="span-two">
              Report name
              <input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <button className="button primary" disabled={pending || !name.trim()} type="submit">
              {pending ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      )}
      {showRegenerate && (
        <form className="reports-create-card" onSubmit={regenerate}>
          <div className="section-heading">
            <div><span>Regenerate report</span><h2>Describe the structure or emphasis you want</h2></div>
          </div>
          <div className="reports-controls">
            <label>
              Generator
              <select value={reporter} onChange={(event) => setReporter(event.target.value)}>
                <option value="codex">Codex</option>
                <option value="hermes">Hermes</option>
              </select>
            </label>
            <label>
              Writing style
              <select value={format} onChange={(event) => setFormat(event.target.value)}>
                <option value="summary">Bullet-point summary</option>
                <option value="detailed">Detailed report</option>
              </select>
            </label>
            <label className="span-two">
              Instructions
              <textarea required maxLength={4000} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Example: Lead with an executive summary, then group contributions by project and outcome." />
            </label>
            <button className="button primary" disabled={pending || !prompt.trim()} type="submit">
              {pending ? "Regenerating…" : "Regenerate report"}
            </button>
          </div>
        </form>
      )}
      {message && <div className="alert success" role="status">{message}</div>}
      {regenerationStatus && (
        <div className="alert progress action-progress" role="status" aria-live="polite">
          <BusyIndicator label={regenerationStatus} />
          <ProgressTrack label={regenerationStatus} />
        </div>
      )}
      {refreshPending && (
        <div className="alert progress action-progress" role="status" aria-live="polite">
          <BusyIndicator label="Loading the latest report content…" />
          <ProgressTrack label="Loading the latest report content" />
        </div>
      )}
      {error && <div className="alert error" role="alert">{error}</div>}
      <React.Suspense fallback={<BusyIndicator label="Rendering report…" />}>
        <ReportMarkdown markdown={report.markdown} />
      </React.Suspense>
    </section>
  );
}

function Reports({ workspaceId, dates, setDates, reports, reload, error, timezone, role }: any) {
  const [reporter, setReporter] = useState("hermes");
  const [format, setFormat] = useState("summary");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [job, setJob] = useState<ReportJob>();
  const [includeDiff, setIncludeDiff] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const operationScope = useRef({workspaceId, generation: 0});
  const pollingGeneration = useRef(0);
  const restorationGeneration = useRef(0);
  if (operationScope.current.workspaceId !== workspaceId) {
    operationScope.current = {workspaceId, generation: operationScope.current.generation + 1};
  }
  useEffect(() => () => {
    operationScope.current.generation += 1;
    pollingGeneration.current += 1;
    restorationGeneration.current += 1;
  }, []);
  const progress = job ? reportJobProgress(job) : undefined;
  useEffect(() => {
    const generation = ++restorationGeneration.current;
    const operation = operationScope.current.generation;
    const active = () => generation === restorationGeneration.current && operation === operationScope.current.generation;
    setJob(undefined);
    request(`/workspaces/${workspaceId}/report-jobs/active`)
      .then((restored) => { if (active()) setJob(restored || undefined); })
      .catch((caught: any) => { if (active()) setActionError(caught.message || "Could not restore report progress."); });
    return () => { restorationGeneration.current += 1; };
  }, [workspaceId]);
  useEffect(() => {
    if (!job?.id || !progress?.active) return;
    const generation = ++pollingGeneration.current;
    const active = () => generation === pollingGeneration.current && operationScope.current.workspaceId === workspaceId;
    void waitForReportJob(
      job.id,
      (jobId) => request(`/reports/jobs/${jobId}`),
      {isActive: active, onStatus: (latest) => { if (active()) setJob(latest as ReportJob); }},
    ).then(async (latest) => {
      if (!latest || !active()) return;
      if (latest.status === "failed") setActionError(latest.error || "Report generation failed.");
      else if (latest.status === "completed") {
        setMessage("Report generated successfully.");
        await reload();
      } else setMessage("Report is still processing. Use Refresh reports to check again.");
    }).catch((caught: any) => {
      if (active()) setActionError(caught.message || "Could not check report progress.");
    });
    return () => { pollingGeneration.current += 1; };
  }, [job?.id, workspaceId]);
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Workspace reports"
        title="Reports"
        description="Review individual reports from every workspace member alongside whole-workspace summary reports."
      />
      {role === "Manager" && <ReportSchedule api={request} workspaceId={workspaceId} timezone={timezone} />}
      <section className="card reports-create-card">
        <div className="section-heading">
          <div>
            <span>New report</span>
            <h2>Choose the evidence window</h2>
          </div>
        </div>
        <div className="reports-controls">
          <label className="span-two">
            Report name <small>(optional)</small>
            <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: August platform delivery review" />
          </label>
          <label>
            From
            <input
              type="date"
              value={dates.from}
              onChange={(event) => setDates({ ...dates, from: event.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={dates.to}
              onChange={(event) => setDates({ ...dates, to: event.target.value })}
            />
          </label>
          <label>
            Generator
            <select value={reporter} onChange={(event) => setReporter(event.target.value)}>
              <option value="codex">Codex</option>
              <option value="hermes">Hermes</option>
            </select>
          </label>
          <label>
            Writing style
            <select value={format} onChange={(event) => setFormat(event.target.value)}>
              <option value="summary">Bullet-point summary</option>
              <option value="detailed">Detailed report</option>
            </select>
          </label>
          <button
            className="button primary"
            disabled={pending || Boolean(progress?.active)}
            onClick={async () => {
              const operation = ++operationScope.current.generation;
              restorationGeneration.current += 1;
              const active = () => operation === operationScope.current.generation;
              setPending(true);
              setActionError("");
              try {
                const created = await request("/reports/jobs", {
                  method: "POST",
                  body: JSON.stringify({
                    workspaceId: String(workspaceId),
                    startDate: dates.from,
                    endDate: dates.to,
                    reporter,
                    format,
                    name,
                    timezone,
                    includeDiff,
                  }),
                });
                if (!active()) return;
                setName("");
                setJob(created);
                setMessage("Report queued. A connected device will generate it shortly.");
              } catch (caught: any) {
                if (active()) setActionError(caught.message);
              } finally {
                if (active()) setPending(false);
              }
            }}
          >
            {pending ? <BusyIndicator label="Queueing report…" /> : progress?.active ? "Report in progress" : "Generate report"}
          </button>
        </div>
        {progress && (
          <div className={`alert ${progress.tone} action-progress`} role={progress.tone === "error" ? "alert" : "status"} aria-live="polite">
            {progress.active ? <><BusyIndicator label={progress.label} /><ProgressTrack label={progress.label} /></> : progress.label}
          </div>
        )}
        <label className="diff-consent">
          <input type="checkbox" checked={includeDiff} onChange={(event) => setIncludeDiff(event.target.checked)} />
          <span>
            <strong>Analyze code changes in detail</strong>
            <small>Includes bounded Git diff excerpts so the report can explain exact features and behavior. Selected source excerpts are sent to the configured AI generator.</small>
          </span>
        </label>
        {message && <div className="alert success" role="status">{message}</div>}
        {actionError && <div className="alert error" role="alert">{actionError}</div>}
      </section>
      <section className="card reports-list-card">
        <div className="section-heading">
          <div>
            <span>History</span>
            <h2>Member and workspace reports</h2>
          </div>
          <div className="actions">
            <span className="count-badge">{reports.length}</span>
            <button className="button secondary" disabled={refreshPending} onClick={async () => {
              setRefreshPending(true);
              try { await reload(); } finally { setRefreshPending(false); }
            }}>
              {refreshPending ? <BusyIndicator label="Refreshing…" /> : "Refresh reports"}
            </button>
          </div>
        </div>
        {refreshPending && <ProgressTrack label="Refreshing report history" />}
        {reports.length ? reports.map((item: any) => (
          <button
            className="repo"
            key={item.id}
            onClick={() => navigate(`/workspaces/${workspaceId}/reports/${item.id}`)}
          >
            <strong>{item.name || `${item.start_date} — ${item.end_date}`}</strong>
            <small>{item.report_scope === "workspace" ? "Workspace summary" : "Individual report"} · {item.start_date} — {item.end_date} · {item.user_name}</small>
          </button>
        )) : <EmptyState title="No reports yet" text="Generate the first report for this workspace." />}
      </section>
      {error && <div className="alert error" role="alert">{error}</div>}
    </div>
  );
}

function App() {
  const [token, setToken] = useState(localStorage.token || "");
  const [identityPending, setIdentityPending] = useState(Boolean(localStorage.token));
  const [workspacePending, setWorkspacePending] = useState(false);
  const [route, setRoute] = useState(location.pathname);
  const [user, setUser] = useState<any>();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [invitationLoadError, setInvitationLoadError] = useState("");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(0);
  const [events, setEvents] = useState<any[]>([]);
  const [repositories, setRepositories] = useState<any[]>([]);
  const [repositoryCandidates, setRepositoryCandidates] = useState<RepositoryCandidate[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({ totals: {}, daily: [] });
  const [report, setReport] = useState<any>();
  const [error, setError] = useState("");
  const [timezone, setTimezone] = useState(initialTimezone);
  const [theme, setTheme] = useState<Theme>(() => normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY)));
  const [dates, setDates] = useState(() => {
    const date = todayInTimezone(initialTimezone());
    return {from: date, to: date};
  });
  const [dialog, setDialog] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const loadGeneration = useRef(0);
  const loadedContexts = useRef(new Set<string>());
  const identityGeneration = useRef(0);
  const dataWorkspaceId = useRef(workspaceId);
  useLayoutEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  }, [theme]);
  useLayoutEffect(() => {
    if (dataWorkspaceId.current === workspaceId) return;
    dataWorkspaceId.current = workspaceId;
    loadGeneration.current += 1;
    setEvents([]);
    setRepositories([]);
    setRepositoryCandidates([]);
    setMembers([]);
    setReports([]);
    setAgents([]);
    setStats({totals: {}, daily: []});
    setReport(undefined);
    setError("");
  }, [workspaceId]);
  useEffect(() => {
    const listener = () => {
      const nextRoute = location.pathname;
      setRoute(nextRoute);
      setReport(undefined);
      const restoredWorkspace = getRouteContext(nextRoute).workspaceId;
      if (restoredWorkspace) setWorkspaceId(restoredWorkspace);
    };
    addEventListener("popstate", listener);
    return () => removeEventListener("popstate", listener);
  }, []);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId),
    [workspaces, workspaceId],
  );
  const loadIdentity = async (preferredId?: number, active: () => boolean = () => true) => {
    setIdentityPending(true);
    const generation = ++identityGeneration.current;
    try {
      const [{user: me, workspaces: list}, inboxResult] = await Promise.all([
        request("/bootstrap"),
        request("/invitations")
          .then((value) => ({ value }))
          .catch((error) => ({ error })),
      ]);
      if (!active() || generation !== identityGeneration.current) return 0;
      setUser(me);
      setWorkspaces(list);
      if ("value" in inboxResult) {
        setInvitations(inboxResult.value);
        setInvitationLoadError("");
      } else {
        setInvitationLoadError(inboxResult.error?.message || "Invitation inbox is temporarily unavailable.");
      }
      const routeWorkspace = Number(
        location.pathname.match(/^\/workspaces\/(\d+)/)?.[1],
      );
      const candidate = preferredId || routeWorkspace || workspaceId;
      const selected = list.some((item: any) => item.id === candidate)
        ? candidate
        : list[0]?.id || 0;
      setWorkspaceId(selected);
      return selected;
    } catch {
      if (!active() || generation !== identityGeneration.current) return 0;
      localStorage.removeItem("token");
      setToken("");
      return 0;
    } finally {
      if (active()) setIdentityPending(false);
    }
  };
  const loadWorkspace = async (blocking = false) => {
    const generation = ++loadGeneration.current;
    const selectedWorkspace = workspaceId;
    const selectedRoute = route;
    const selectedView = getRouteView(selectedRoute, selectedWorkspace);
    const context = `${selectedWorkspace}:${selectedView === "report" ? selectedRoute : selectedView}`;
    const shouldBlock = blocking && !loadedContexts.current.has(context);
    if (shouldBlock) setWorkspacePending(true);
    if (!selectedWorkspace) {
      setEvents([]);
      setRepositories([]);
      setRepositoryCandidates([]);
      setMembers([]);
      setReports([]);
      setAgents([]);
      setStats({ totals: {}, daily: [] });
      if (shouldBlock) setWorkspacePending(false);
      return;
    }
    try {
      setError("");
      const plan = workspaceLoadPlan(selectedRoute, selectedWorkspace, dates, timezone);
      const loaded = await Promise.all(
        plan.map(async (item) => [item.key, await request(item.path)] as const),
      );

      if (generation !== loadGeneration.current) return;
      const apply: Record<WorkspaceLoadKey, (value: any) => void> = {
        dashboard: (value) => {
          setEvents(value.events);
          setRepositories(value.repositories);
          setStats(value.stats);
        },
        settings: (value) => {
          setMembers(value.members);
          setRepositories(value.repositories);
          setRepositoryCandidates(value.repositoryCandidates);
          setAgents(value.agents);
        },
        reports: setReports,
        agents: setAgents,
        report: (detail) => {
          if (!reportMatchesRoute(detail, selectedRoute))
            throw new Error("Report does not belong to this workspace.");
          setReport(detail);
        },
      };
      for (const [key, value] of loaded) apply[key](value);
      loadedContexts.current.add(context);
    } catch (caught: any) {
      if (generation === loadGeneration.current) {
        if (getRouteView(selectedRoute, selectedWorkspace) === "report")
          setReport(undefined);
        setError(caught.message);
      }
    } finally {
      if (shouldBlock && generation === loadGeneration.current) setWorkspacePending(false);
    }
  };
  useEffect(() => {
    if (token) void loadIdentity();
  }, [token]);
  useEffect(() => {
    void loadWorkspace(true);
  }, [workspaceId, route, dates.from, dates.to, timezone]);
  if (!token) return (
    <>
      <ThemeToggle theme={theme} onToggle={() => setTheme(nextTheme(theme))} floating />
      <Auth onLogin={setToken} route={route} />
    </>
  );
  if (identityPending) return (
    <LoadingSurface
      fullScreen
      label="Verifying your session…"
      detail="Loading your account and available workspaces securely."
    />
  );
  const view = getRouteView(route, workspaceId);
  const openWorkspace = async (preferredId?: number) => {
    const selected = await loadIdentity(preferredId);
    if (selected) navigate(workspacePath(selected));
  };
  const navItems = [
    { label: "Dashboard", section: "" },
    { label: "Reports", section: "reports" },
    { label: "Install CLI", section: "install" },
    { label: "Settings", section: "settings" },
  ];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <button
          className="sidebar-brand"
          onClick={() => navigate(workspacePath(workspaceId))}
        >
          <Brand />
        </button>
        <p className="workspace-label">Developer command center</p>
        <label className="workspace-select">
          Workspace
          <select
            value={workspaceId}
            onChange={(event) => {
              const selected = +event.target.value;
              setWorkspaceId(selected);
              navigate(workspacePath(selected));
            }}
          >
            <option value={0}>No workspace selected</option>
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="workspace-select">
          Timezone
          <select
            value={timezone}
            onChange={(event) => {
              const selected = normalizeTimezone(event.target.value);
              localStorage.setItem("timezone", selected);
              setTimezone(selected);
            }}
          >
            {TIMEZONE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <nav aria-label="Primary navigation">
          {navItems.map((item) => {
            const path = workspacePath(workspaceId, item.section);
            const active = item.section
              ? item.section === "reports"
                ? view === "reports" || view === "report"
                : route.endsWith(`/${item.section}`)
              : view === "dashboard";
            return (
              <button
                key={item.label}
                className={active ? "nav-link active" : "nav-link"}
                onClick={() => navigate(path)}
              >
                <span className="nav-index">0{navItems.indexOf(item) + 1}</span>
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className="status online" />
          <div>
            <strong>{user?.name}</strong>
            <small>Signed in</small>
          </div>
        </div>
      </aside>
      <div className="content-column">
        <header className="topbar">
          <div>
            <span className="eyebrow">TraceMini workspace</span>
            <strong>{workspace?.name || "Workspace setup"}</strong>
          </div>
          <div className="topbar-actions">
            {logoutError && <span className="topbar-error" role="alert">{logoutError}</span>}
            <button className="button secondary inbox-button" onClick={() => setInboxOpen(true)}>
              Invitations
              {invitations.some((item) => item.status === "PENDING") && <span className="count-badge">{invitations.filter((item) => item.status === "PENDING").length}</span>}
            </button>
            <ThemeToggle theme={theme} onToggle={() => setTheme(nextTheme(theme))} />
            <button
              className="button primary"
              onClick={() => setDialog(true)}
            >
              New workspace
            </button>
            <button
              className="logout"
              disabled={logoutPending}
              onClick={async () => {
                setLogoutPending(true);
                setLogoutError("");
                try {
                  await request("/auth/logout", { method: "POST" });
                  localStorage.removeItem("token");
                  setToken("");
                  navigate("/");
                } catch (caught: any) {
                  setLogoutError(caught.message || "Could not log out.");
                } finally {
                  setLogoutPending(false);
                }
              }}
            >
              {logoutPending ? <BusyIndicator label="Logging out…" /> : "Log out"}
            </button>
          </div>
        </header>
        <main id="main-content">
          {workspacePending && workspaceId ? (
            <LoadingSurface
              label={view === "report" ? "Loading report…" : "Loading workspace…"}
              detail={view === "report"
                ? "Retrieving the report content and its latest status."
                : "Fetching the information needed for this view."}
            />
          ) : view === "workspace-required" || !workspaceId ? (
            <WorkspaceRequired openDialog={() => setDialog(true)} />
          ) : view === "install" ? (
            <Install key={workspaceId} workspaceId={workspaceId} agents={agents} userId={user?.id} onAgentsChecked={(nextAgents) => {
              if (dataWorkspaceId.current === workspaceId) setAgents(nextAgents);
            }} />
          ) : view === "settings" ? (
            <Settings
              key={workspaceId}
              workspace={workspace}
              members={members}
              repositories={repositories}
              repositoryCandidates={repositoryCandidates}
              agents={agents}
              userId={user?.id}
              reloadCandidates={loadWorkspace}
              reload={async () => {
                const expectedWorkspace = workspaceId;
                const selected = await loadIdentity(expectedWorkspace, () => dataWorkspaceId.current === expectedWorkspace);
                if (selected === expectedWorkspace && dataWorkspaceId.current === expectedWorkspace) await loadWorkspace();
              }}
            />
          ) : view === "reports" ? (
            <Reports
              key={workspaceId}
              workspaceId={workspaceId}
              dates={dates}
              setDates={setDates}
              reports={reports}
              reload={loadWorkspace}
              error={error}
              timezone={timezone}
              role={workspace?.role}
            />
          ) : view === "report" ? (
            reportMatchesRoute(report, route) ? (
              <ReportDetail key={`${workspaceId}:${report.id}`} report={report} workspaceId={workspaceId} currentUserId={user?.id} reload={loadWorkspace} />
            ) : (
              <section className="card">
                <h2>{error ? "Could not load report" : "Report unavailable"}</h2>
                {error && (
                  <div className="alert error" role="alert">
                    {error}
                  </div>
                )}
              </section>
            )
          ) : (
            <Dashboard
              key={workspaceId}
              workspaceId={workspaceId}
              route={route}
              dates={dates}
              setDates={setDates}
              stats={stats}
              events={events}
              repositories={repositories}
              reload={loadWorkspace}
              error={error}
              timezone={timezone}
            />
          )}
        </main>
      </div>
      {dialog && (
        <WorkspaceDialog
          close={() => setDialog(false)}
          complete={openWorkspace}
        />
      )}
      {inboxOpen && (
        <InvitationInbox
          api={request}
          invitations={invitations}
          loadError={invitationLoadError}
          onClose={() => setInboxOpen(false)}
          onChanged={async () => {
            await loadIdentity();
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
