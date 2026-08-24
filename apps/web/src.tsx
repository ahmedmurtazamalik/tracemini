import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getRouteContext,
  getRouteView,
  reportDuringLoad,
  reportMatchesRoute,
  workspacePath,
} from "./routes.js";
import { downloadReport } from "./report-download.js";
import { checkCliConnection } from "./device-connection.js";
import { reportJobProgress, type ReportJob } from "./report-progress.js";
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
const navigate = (path: string) => {
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
};
const today = () => new Date().toISOString().slice(0, 10);

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

function Install({ workspaceId, agents, userId, onAgentsChecked }: { workspaceId: number; agents: any[]; userId: number; onAgentsChecked: (agents: any[]) => void }) {
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
      onAgentsChecked(result.agents);
      setCheckMessage(
        result.state === "connected"
          ? `${result.machineNames.join(", ")} ${result.machineNames.length === 1 ? "is" : "are"} connected.`
          : result.state === "offline"
            ? `CLI found on ${result.machineNames.join(", ")}, but it is offline.`
            : "No CLI device was found for your account in this workspace.",
      );
    } catch (caught: any) {
      setError(caught.message || "Could not check the CLI connection.");
    } finally {
      setCheckPending(false);
    }
  };
  const mint = async () => {
    setError("");
    setPending(true);
    try {
      setInstallation(
        await request("/agents/installations", {
          method: "POST",
          body: JSON.stringify({ workspaceId }),
        }),
      );
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setPending(false);
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
        description="Connect this Linux computer to the selected workspace without uploading source code."
      />
      <section className="card device-detection" aria-live="polite">
        <span>Automatic CLI detection</span>
        <h2>{onlineDevices.length ? "CLI connected" : personalDevices.length ? "CLI installed, device offline" : "CLI not detected"}</h2>
        <p className="muted">
          {onlineDevices.length
            ? `${onlineDevices.map((device) => device.machine_name).join(", ")} ${onlineDevices.length === 1 ? "is" : "are"} sending heartbeats to this workspace.`
            : personalDevices.length
              ? `TraceMini was installed on ${personalDevices.map((device) => device.machine_name).join(", ")}, but no heartbeat was received in the last minute.`
              : "No TraceMini device has connected for your account in this workspace yet."}
        </p>
        <button className="button secondary" onClick={checkConnection} disabled={checkPending}>
          {checkPending ? "Checking…" : "Check CLI connection"}
        </button>
        {checkMessage && <p className="muted" role="status">{checkMessage}</p>}
      </section>
      <section className="card install-card">
        <div className="step-number">01</div>
        <div>
          <h2>Connect or sync this computer</h2>
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
                  : "Connect or sync this computer"}
            </button>
          ) : (
            <>
              <div className="alert progress" role="status">
                Run this command on the computer. It installs or updates the CLI, safely connects it to this account, and keeps your watched folders.
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
}: {
  events: any[];
  workspaceId: number;
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
              <time>{new Date(event.occurred_at).toLocaleString()}</time>
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

function Settings({ workspace, members, repositories, agents, reload }: any) {
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
      await reload();
      setMessage("Workspace updated.");
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setPending(false);
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
          You are a Member. This page is read-only.
        </div>
        <div className="settings-grid">
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
                <option>Member</option>
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
        <section className="card settings-card">
          <span>Access</span>
          <h2>Workspace invite</h2>
          <p className="muted">The code is random. It can be refreshed once per minute.</p>
          <p className="invite-code">
            {workspace.invite_enabled ? workspace.invite_code : "Disabled"}
          </p>
          <div className="actions">
            <button
              className="button secondary"
              onClick={() =>
                mutate(`/workspaces/${workspace.id}/invite/regenerate`)
              }
            >
              Refresh invite code
            </button>
            <button
              className="button secondary"
              onClick={() =>
                mutate(`/workspaces/${workspace.id}/invite/disable`)
              }
            >
              Disable
            </button>
          </div>
        </section>
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
                {agent.status !== "revoked" && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      mutate(
                        `/workspaces/${workspace.id}/agents/${agent.id}/revoke`,
                      )
                    }
                  >
                    Revoke
                  </button>
                )}
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
  openDialog: (mode: "create" | "join") => void;
}) {
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Workspace setup"
        title="Connect your first workspace."
        description="CLI installation and settings belong to a workspace. Create one or join your team before continuing."
      />
      <section className="card onboarding-card">
        <div className="onboarding-icon" aria-hidden="true">
          01
        </div>
        <div>
          <h2>Choose how to begin</h2>
          <p>
            Create a workspace if you manage the team, or join with an invite
            code from a Manager.
          </p>
          <div className="actions">
            <button
              className="button primary"
              onClick={() => openDialog("create")}
            >
              Create workspace
            </button>
            <button
              className="button secondary"
              onClick={() => openDialog("join")}
            >
              Join workspace
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function WorkspaceDialog({
  mode,
  close,
  complete,
}: {
  mode: "create" | "join";
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
        <h2 id="workspace-dialog-title">
          {mode === "create" ? "Create a workspace" : "Join a workspace"}
        </h2>
        <p>
          {mode === "create"
            ? "Give your team workspace a clear name."
            : "Enter the invite code supplied by a workspace Manager."}
        </p>
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
              const result = await request(
                mode === "create" ? "/workspaces" : "/workspaces/join",
                { method: "POST", body: JSON.stringify(values) },
              );
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
            {mode === "create" ? "Workspace name" : "Invite code"}
            <input
              autoFocus
              name={mode === "create" ? "name" : "inviteCode"}
              required
            />
          </label>
          <div className="actions">
            <button className="button secondary" type="button" onClick={close}>
              Cancel
            </button>
            <button className="button primary" disabled={pending}>
              {pending
                ? <BusyIndicator label={mode === "create" ? "Creating workspace…" : "Joining workspace…"} />
                : mode === "create"
                  ? "Create workspace"
                  : "Join workspace"}
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
  refreshes,
  agents,
  reload,
  error,
}: any) {
  const [refreshPending, setRefreshPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
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
        <Activity events={events} workspaceId={workspaceId} />
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
              setActionError("");
              setActionMessage("");
              try {
                const queued = await request(`/workspaces/${workspaceId}/refresh`, {
                  method: "POST",
                });
                setActionMessage(
                  `${queued.requestCount} device refresh ${queued.requestCount === 1 ? "was" : "were"} queued. Recent Git history will be imported.`,
                );
                await reload();
              } catch (caught: any) {
                setActionError(caught.message);
              } finally {
                setRefreshPending(false);
              }
            }}
          >
            {refreshPending ? "Queueing refresh…" : "Refresh repositories"}
          </button>
          {actionMessage && (
            <div className="alert success compact" role="status">
              {actionMessage}
            </div>
          )}
          {actionError && (
            <div className="alert error compact" role="alert">
              {actionError}
            </div>
          )}
          {refreshes.slice(0, 3).map((item: any) => (
            <p className="muted compact" key={item.id}>
              {item.status}
              {item.error
                ? `: ${item.error}`
                : item.repositories_found !== null
                  ? ` · ${item.repositories_found} found`
                  : ""}
            </p>
          ))}
          <h3>Devices</h3>
          {agents.map((agent: any) => (
            <p className="agent-line" key={agent.id}>
              <i className={`status ${agent.status}`} /> {agent.machine_name}
              <small>{agent.status}</small>
            </p>
          ))}
          {!agents.length && <p className="muted">No device connected.</p>}
        </aside>
      </div>
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
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");
    try {
      const updated = await request(`/reports/${report.id}`, {method: "PATCH", body: JSON.stringify({name})});
      setName(updated.name);
      setMessage("Report renamed successfully.");
      setShowRename(false);
      await reload();
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  };
  const regenerate = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");
    try {
      const job = await request(`/reports/${report.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ reporter, prompt }),
      });
      setMessage("Regeneration queued. Waiting for the connected device…");
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await request(`/reports/jobs/${job.id}`);
        if (status.status === "completed") {
          setMessage("Report regenerated successfully.");
          setShowRegenerate(false);
          setPrompt("");
          await reload();
          return;
        }
        if (status.status === "failed") throw new Error(status.error || "Report regeneration failed.");
      }
      setMessage("Regeneration is still processing. The updated report will appear after it completes.");
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="card report">
      <div className="section-heading report-heading">
        <div><span>Engineering contribution report</span><h1>{report.name || `${report.start_date} — ${report.end_date}`}</h1></div>
      </div>
      <div className="actions report-actions">
        <button className="button secondary" onClick={() => navigate(workspacePath(workspaceId, "reports"))}>
          ← Report history
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
        <button className="button primary" onClick={() => downloadReport(report)}>
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
      {error && <div className="alert error" role="alert">{error}</div>}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.markdown}</ReactMarkdown>
    </section>
  );
}

function Reports({ workspaceId, dates, setDates, reports, reload, error }: any) {
  const [reporter, setReporter] = useState("codex");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [job, setJob] = useState<ReportJob>();
  const [actionError, setActionError] = useState("");
  const progress = job ? reportJobProgress(job) : undefined;
  useEffect(() => {
    if (!job?.id || !progress?.active) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await request(`/reports/jobs/${job.id}`);
        if (cancelled) return;
        setJob(latest);
        if (latest.status === "completed") {
          await reload();
        }
      } catch (caught: any) {
        if (!cancelled) setActionError(caught.message || "Could not check report progress.");
      }
    };
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);
  return (
    <div className="page-stack">
      <PageHeading
        eyebrow="Workspace reports"
        title="Reports"
        description="Create and review engineering contribution reports without digging through individual commits."
      />
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
          <button
            className="button primary"
            disabled={pending || Boolean(progress?.active)}
            onClick={async () => {
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
                    name,
                  }),
                });
                setName("");
                setJob(created);
              } catch (caught: any) {
                setActionError(caught.message);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? <BusyIndicator label="Queueing report…" /> : progress?.active ? "Report in progress" : "Generate report"}
          </button>
        </div>
        {progress && (
          <div className={`alert ${progress.tone}`} role={progress.tone === "error" ? "alert" : "status"} aria-live="polite">
            {progress.active ? <BusyIndicator label={progress.label} /> : progress.label}
          </div>
        )}

        {actionError && <div className="alert error" role="alert">{actionError}</div>}
      </section>
      <section className="card reports-list-card">
        <div className="section-heading">
          <div>
            <span>History</span>
            <h2>Completed reports</h2>
          </div>
          <span className="count-badge">{reports.length}</span>
        </div>
        {reports.length ? reports.map((item: any) => (
          <button
            className="repo"
            key={item.id}
            onClick={() => navigate(`/workspaces/${workspaceId}/reports/${item.id}`)}
          >
            <strong>{item.name || `${item.start_date} — ${item.end_date}`}</strong>
            <small>{item.start_date} — {item.end_date} · {item.user_name}</small>
          </button>
        )) : <EmptyState title="No reports yet" text="Generate the first report for this workspace." />}
      </section>
      {error && <div className="alert error" role="alert">{error}</div>}
    </div>
  );
}

function App() {
  const [token, setToken] = useState(localStorage.token || "");
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
  const [stats, setStats] = useState<any>({ totals: {}, daily: [] });
  const [report, setReport] = useState<any>();
  const [error, setError] = useState("");
  const [dates, setDates] = useState({ from: today(), to: today() });
  const [dialog, setDialog] = useState<"create" | "join">();
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const loadGeneration = useRef(0);
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
  const loadIdentity = async (preferredId?: number) => {
    try {
      const [me, list] = await Promise.all([
        request("/auth/me"),
        request("/workspaces"),
      ]);
      setUser(me);
      setWorkspaces(list);
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
      localStorage.removeItem("token");
      setToken("");
      return 0;
    }
  };
  const loadWorkspace = async () => {
    const generation = ++loadGeneration.current;
    const selectedWorkspace = workspaceId;
    const selectedRoute = route;
    setReport((current: any) => reportDuringLoad(current, selectedRoute));
    if (!selectedWorkspace) {
      setEvents([]);
      setRepositories([]);
      setMembers([]);
      setReports([]);
      setAgents([]);
      setRefreshes([]);
      setStats({ totals: {}, daily: [] });
      return;
    }
    try {
      setError("");
      const match = selectedRoute.match(
        /^\/workspaces\/\d+\/(users|repositories)\/(\d+)/,
      );
      const eventPath = match
        ? `/${match[1]}/${match[2]}/activity?workspaceId=${selectedWorkspace}&from=${dates.from}&to=${dates.to}`
        : `/workspaces/${selectedWorkspace}/activity?from=${dates.from}&to=${dates.to}`;
      const statsFilter = match
        ? `&${match[1] === "users" ? "userId" : "repositoryId"}=${match[2]}`
        : "";
      const routeContext = getRouteContext(selectedRoute);
      const [
        activity,
        repos,
        people,
        history,
        machines,
        refreshHistory,
        summary,
        detail,
      ] = await Promise.all([
        request(eventPath),
        request(
          `/workspaces/${selectedWorkspace}/repositories?includeArchived=true`,
        ),
        request(`/workspaces/${selectedWorkspace}/members`),
        request(`/workspaces/${selectedWorkspace}/reports`),
        request(`/workspaces/${selectedWorkspace}/agents`),
        request(`/workspaces/${selectedWorkspace}/refresh`),
        request(
          `/workspaces/${selectedWorkspace}/stats?from=${dates.from}&to=${dates.to}${statsFilter}`,
        ),
        routeContext.reportId
          ? request(`/reports/${routeContext.reportId}`)
          : Promise.resolve(undefined),
      ]);
      if (generation !== loadGeneration.current) return;
      if (detail && !reportMatchesRoute(detail, selectedRoute))
        throw new Error("Report does not belong to this workspace.");
      setEvents(activity);
      setRepositories(repos);
      setMembers(people);
      setReports(history);
      setAgents(machines);
      setRefreshes(refreshHistory);
      setStats(summary);
      setReport(detail);
    } catch (caught: any) {
      if (generation === loadGeneration.current) {
        setReport(undefined);
        setError(caught.message);
      }
    }
  };
  useEffect(() => {
    if (token) void loadIdentity();
  }, [token]);
  useEffect(() => {
    if (!workspaceId) {
      void loadWorkspace();
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await loadWorkspace();
      if (!cancelled) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, route, dates.from, dates.to]);
  if (!token) return <Auth onLogin={setToken} route={route} />;
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
            <button
              className="button secondary"
              onClick={() => setDialog("join")}
            >
              Join
            </button>
            <button
              className="button primary"
              onClick={() => setDialog("create")}
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
          {view === "workspace-required" || !workspaceId ? (
            <WorkspaceRequired openDialog={setDialog} />
          ) : view === "install" ? (
            <Install workspaceId={workspaceId} agents={agents} userId={user?.id} onAgentsChecked={setAgents} />
          ) : view === "settings" ? (
            <Settings
              workspace={workspace}
              members={members}
              repositories={repositories}
              agents={agents}
              reload={async () => {
                await loadIdentity();
                await loadWorkspace();
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
            />
          ) : view === "report" ? (
            reportMatchesRoute(report, route) ? (
              <ReportDetail report={report} workspaceId={workspaceId} currentUserId={user?.id} reload={loadWorkspace} />
            ) : (
              <section className="card">
                <h2>Loading report…</h2>
                {error && (
                  <div className="alert error" role="alert">
                    {error}
                  </div>
                )}
              </section>
            )
          ) : (
            <Dashboard
              workspaceId={workspaceId}
              route={route}
              dates={dates}
              setDates={setDates}
              stats={stats}
              events={events}
              repositories={repositories}
              refreshes={refreshes}
              agents={agents}
              reload={loadWorkspace}
              error={error}
            />
          )}
        </main>
      </div>
      {dialog && (
        <WorkspaceDialog
          mode={dialog}
          close={() => setDialog(undefined)}
          complete={openWorkspace}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
