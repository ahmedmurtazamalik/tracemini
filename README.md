# TraceMini

TraceMini is a small self-hosted activity dashboard and local Git agent for 4–6 developers. Express serves the API and built React/Vite app, Supabase-hosted PostgreSQL stores metadata and Markdown reports, and the local TypeScript CLI observes explicitly watched Git roots. TraceMini does not store source code or call Git-hosting provider APIs.

## Requirements and verification

- Node.js 22 (the package engine requirement; development is also checked under the current local Node runtime)
- npm 10+
- Git
- Linux with a working systemd user session
- Optional for report generation: an authenticated local `codex` or `hermes` executable

```bash
npm install --workspaces --include-workspace-root
npm test
npm run typecheck
npm run build
npm run acceptance
npm start -w @tracemini/server
```

The built Express process serves the API and `apps/web/dist` at `http://localhost:3000`. Set `DATABASE_URL` to the Supabase PostgreSQL Session Pooler connection string; the backend connects directly with `pg` and applies versioned migrations under a PostgreSQL advisory lock at startup. Connections using `sslmode=require` are upgraded to certificate and hostname verification with the bundled Supabase Root 2021 CA (or the certificate at `PGSSLROOTCERT`). Keep the Supabase Data API disabled because clients access data only through this backend. `PORT` defaults to `3000`. Tests and acceptance use isolated in-memory PostgreSQL emulation; the release gate additionally runs a temporary, cleaned-up workflow against the hosted PostgreSQL database. No persistent SQLite volume is required.

## Workspace and CLI onboarding

Roles are only **Manager** and **Developer**. A workspace creator is its first Manager. Managers invite an existing TraceMini account by email; the recipient receives a private inbox invitation and gets no workspace access until accepting it. Legacy shared invite codes and code-based joins are retired and are never returned by workspace APIs. Managers can revoke pending invitations, promote/demote existing developers, remove members, approve repository proposals, archive repositories, configure workspace report schedules, and delete the workspace. A mutation that would leave zero Managers is rejected. Developers can scan their own approved device folders and see their proposal status, but only Managers can authorize tracing. A device is account-level rather than owned by one workspace, so only its owner can revoke it; revocation disconnects that device from every workspace.

From **Install CLI** in the authenticated web app, generate and copy the Linux install command. The command uses `curl` to download a server-generated installer file and then runs that local file; it does not pipe network content directly into a shell. The installer contains a short-lived, single-use opaque install token, installs the compiled dependency-free CLI under `~/.local/share/tracemini/cli`, creates `~/.local/bin/tracemini`, exchanges the token for a dedicated agent credential, and enables and starts `tracemini.service` with `systemd --user`. It requires Node.js 22+ but does not require npm, a package registry, sudo, or a preinstalled `tracemini` command.

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v tracemini
tracemini status
systemctl --user status tracemini.service --no-pager
journalctl --user -u tracemini.service -n 50 --no-pager
tracemini watch /absolute/path/to/a/root
```

Add `export PATH="$HOME/.local/bin:$PATH"` to the appropriate shell startup file if `~/.local/bin` is not already on `PATH`. A newly started service can have no journal output; `-- No entries --` is normal immediately after installation. Agent credentials, watched roots, clone state, and the retry queue are stored with user-only permissions under `~/.tracemini`; `TRACEMINI_HOME` overrides the state directory. Configuration writes are atomic, and the background service reloads roots and clones written by interactive `tracemini watch` commands instead of overwriting them with an older in-memory snapshot.

Each installed agent is one account/machine device connection that serves every workspace where its owner currently has live membership. The selected workspace is only the active CLI context: changing it does not re-pair the device or rotate its credential. Watched roots, clones, queues, repository activity, repository selection, and report jobs remain workspace-partitioned, and every workspace operation revalidates current membership. Removing a member cancels that workspace's unfinished work and removes only its local partition; the account device remains connected to the owner's other workspaces.

Windows installation and startup support is explicitly deferred.

The dashboard shows agent online/offline state. “Online” means a heartbeat was seen within 60 seconds; it is not a process-health guarantee.

## Discovery and refresh

`watch` recursively discovers repositories only below an explicit root and requires an `origin`. The web **Scan repositories on my devices** action queues a scan on the requesting member's own agents; each agent scans only roots that member previously approved with `tracemini watch`. It publishes bounded workspace-scoped metadata as proposals. Managers can review proposals from all workspace members, but another member's local filesystem path is hidden. No hook installation, history import, or activity tracing starts until a Manager approves the proposal. The agent never performs an unbounded device or full-disk scan.

## Git activity and push confirmation

Managed hooks are `post-commit`, `post-checkout`, `post-merge`, `post-rewrite`, and `pre-push`. A pre-existing hook is preserved as `<hook>.tracemini-original` and runs first.

`pre-push` records a pending push with the remote name/URL and every advertised remote ref and expected local SHA. Because that hook runs before the transfer, the polling agent waits eight seconds before using bounded (8-second), noninteractive `git ls-remote --refs <remote> <ref>`. It stores a push event as `confirmed` only if the observed SHA exactly matches; failed checks are retried twice at ten-second intervals before becoming `unconfirmed`. Network/auth failures, exceptionally long in-flight pushes, later force-pushes, deleted refs, unsupported remote behavior, and mismatches can still end as `unconfirmed`. This is intentionally not universal push confirmation and does not prove what happened between the original push and the later observation.

The agent persists each clone’s branch, local HEAD, and upstream-tracking SHA. It infers a pull/update only when the same branch’s local HEAD and upstream state both move and converge. Ordinary local commits (HEAD-only movement) and branch checkouts are excluded where observable. Exact limitations:

- A fetch followed by reset/rebase to the upstream tip may look like a pull/update.
- A pull that does not make local HEAD equal the upstream-tracking SHA may not be inferred.
- Remote-tracking refs are local cached state until some Git operation updates them; TraceMini does not fetch merely to detect pulls.
- `post-merge` records merges but cannot always distinguish `git pull` from a local merge.
- Hook execution requires `tracemini` on `PATH`; failure of a preserved original hook stops the wrapper first.

## Dashboard and reports

Dashboard cards and daily trends aggregate **commit events only** for commits, files changed, insertions, and deletions; stage events are deliberately excluded. User and repository drill-down pages have stable URLs and the same date filters/stats API. Repository archiving hides it from the active dashboard but preserves clones and all activity.

Reports have URL-addressable history/detail pages and can be downloaded as portable UTF-8 Markdown files. Every workspace member can review the workspace's individual member reports and whole-workspace summaries; each entry is labeled by scope and author. Users choose either a concise bullet-point summary or a detailed narrative, including when regenerating an existing report. Managers can schedule daily, weekday, or selected-day workspace reports at an IANA timezone or fixed UTC offset (`UTC-12:00` through `UTC+14:00`) with a 1–90 day evidence window. A due schedule is materialized idempotently when its configuring Manager's connected agent polls for work; no separate cron service is required. After device downtime, TraceMini recovers the latest due evidence window, records how many older occurrences were coalesced, and includes a schedule-recovery disclosure in the generated report. When `SLACK_WEBHOOK_URL` is configured, manual and scheduled reports can opt in to a short Slack completion message containing only report metadata and a TraceMini link, never report Markdown. Stored Markdown is rendered with `react-markdown` plus `remark-gfm`, including GFM tables and task lists. The polling local agent claims jobs, adds bounded `git show --stat` evidence for relevant local commits when explicitly enabled, and invokes the selected local Codex/Hermes executable. Tests complete reports with deterministic Markdown and do not spend model invocations.

## Exact limitations and exclusions

- No provider APIs/webhooks, source upload, queues, Redis, message broker, additional service, deployment automation, or browser automation.
- No agent crash recovery or concurrent-agent coordination for one shared `TRACEMINI_HOME`; retry storage is a single local JSON file.
- No OAuth or broad AI/report-output testing. Reports are workspace-scoped; there is no cross-workspace organization rollup. Account management is intentionally limited to registration, login/logout, and password recovery.
- Install commands contain bearer-like install tokens internally. They expire after 10 minutes and are single-use, but commands can remain in shell history; protect terminal history and use HTTPS outside localhost.
- The server must be deployed with built CLI artifacts. The installer is not a signed OS package and does not elevate privileges.
- Linux installation depends on a working systemd user session. Windows and macOS startup installation are deferred.
- Repository identity requires `origin` and is based on normalized remote text; unusual aliases can group incorrectly.
- Activity endpoints cap results at 500. UI freshness is polling-based.
- Deleting a workspace is permanent. Archiving repositories is the preservation-oriented alternative.
- HTTPS, backups, process supervision for the Express server, and production hardening belong to the deployment environment.
