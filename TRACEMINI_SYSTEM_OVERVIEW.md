# TraceMini — System Overview

## 1. Project Definition

TraceMini is a small internal web application plus a local CLI/agent for tracking developers' Git activity and generating development reports.

The intended scale is **4–6 users**. The system should therefore favor simplicity, clarity, and ease of development over production-grade distributed architecture.

### Core principle

> **TraceMini knows what happened. The local AI knows what the code means.**

TraceMini stores Git/activity metadata and reports. The user's local TraceMini CLI has access to local repositories and can invoke an already-installed Codex CLI or Hermes CLI for code analysis.

TraceMini does **not** integrate with GitHub, GitLab, Bitbucket, or any other external service.

---

## 2. Goals

TraceMini should provide:

- User accounts
- Workspaces
- Workspace invite codes
- A local TraceMini CLI/agent
- Automatic discovery of local Git repositories
- Tracking of meaningful Git activity
- A web dashboard showing activity
- Per-user and per-repository activity
- Personal daily/custom-range reports
- Local code analysis through Codex CLI or Hermes CLI
- Markdown report storage and display
- A future team-report capability based on individual reports

---

## 3. Explicit Non-Goals

TraceMini should **not** attempt to become a general DevOps or Git hosting platform.

The initial system will not include:

- GitHub API integration
- GitHub webhooks
- GitLab integration
- Bitbucket integration
- Any external Git-hosting API
- Centralized source-code storage
- Centralized repository cloning
- Message brokers
- Kafka
- RabbitMQ
- Redis
- Kubernetes
- Distributed workers
- Artifact storage
- Enterprise audit-log infrastructure
- Complex job orchestration
- Automatic PR synchronization from a Git hosting provider

Pull requests are therefore not treated as first-class externally synchronized objects. The MVP focuses on activity observable from the local Git repository. If PR-like events are eventually required, TraceMini can provide explicit local CLI commands for recording them.

---

## 4. High-Level Architecture

```text
                    ┌───────────────────────┐
                    │      TraceMini Web        │
                    │                       │
                    │ Dashboard             │
                    │ Workspaces            │
                    │ Repositories          │
                    │ Activity               │
                    │ Reports                │
                    └───────────┬───────────┘
                                │
                              HTTPS
                                │
                    ┌───────────▼───────────┐
                    │    TraceMini Backend      │
                    │                       │
                    │ Authentication        │
                    │ Workspace management  │
                    │ Activity API          │
                    │ Report management     │
                    └───────────┬───────────┘
                                │
                              SQLite
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
       TraceMini CLI/Agent   TraceMini CLI/Agent   TraceMini CLI/Agent
          User A             User B             User C
              │                 │                 │
         Local repos       Local repos       Local repos
              │                 │                 │
        Codex/Hermes       Codex/Hermes       Codex/Hermes
```

The TraceMini backend is the central source of activity metadata.

The TraceMini CLI/agent is the component that has access to the developer's machine.

---

## 5. TraceMini Web Application

The web application is responsible for:

### Authentication

- User registration/login
- Session management
- Associating users with TraceMini workspaces

### Workspaces

A workspace represents a team/project.

A workspace has:

- Name
- Owner
- Members
- Invite code
- Repositories

Users can:

- Create a workspace
- Join a workspace using an invite code
- View workspace activity

### Dashboard

The dashboard should provide:

- Recent activity
- Activity grouped by user
- Activity grouped by repository
- Activity grouped by date
- Basic statistics

Example:

```text
Visiogen
────────────────────────────────────────

Ahmed
  6 commits
  3 pushes
  11 files changed

Ali
  4 commits
  2 pushes
  7 files changed

Recent Activity
  10:42  Ahmed committed "Fix note positioning"
  10:45  Ahmed pushed feature/note-resizing
  11:10  Ali committed "Update API validation"
```

---

## 6. TraceMini Backend

The backend exposes a small REST API.

Responsibilities:

- Authentication
- Workspace management
- Agent registration
- Repository registration
- Activity ingestion
- Activity retrieval
- Report job creation
- Report job retrieval
- Report storage/retrieval

The backend should remain stateless where practical.

No real-time distributed infrastructure is required.

If the UI needs live updates, simple polling or a lightweight WebSocket connection can be used. Polling is acceptable for the MVP.

---

## 7. Database

SQLite is sufficient for the intended scale.

Suggested entities:

```text
users
workspaces
workspace_members
agents
repositories
activity_events
report_jobs
reports
```

### Users

```text
id
name
email
password_hash / auth data
created_at
```

### Workspaces

```text
id
name
owner_id
invite_code
created_at
```

### Workspace Members

```text
workspace_id
user_id
role
```

### Agents

Represents a TraceMini CLI installation.

```text
id
user_id
machine_name
last_seen
created_at
```

### Repositories

A repository belongs to a workspace and is identified by its Git remote URL.

```text
id
workspace_id
name
remote_url
created_at
```

The remote URL is used to recognize that multiple local clones belong to the same repository.

### Activity Events

```text
id
user_id
repository_id
type
timestamp
data
```

`data` can be JSON so that different event types can contain different metadata.

Example:

```json
{
  "commit_sha": "abc123",
  "message": "Fix note positioning",
  "branch": "feature/note-positioning",
  "files_changed": 4,
  "insertions": 83,
  "deletions": 31
}
```

### Reports

```text
id
workspace_id
user_id
start_date
end_date
markdown
created_at
```

---

## 8. TraceMini CLI / Agent

The TraceMini CLI is the most important local component.

It serves two purposes:

1. Monitor local Git repositories.
2. Run local code analysis when a report is requested.

Example commands:

```bash
TraceMini login
TraceMini join <invite-code>
TraceMini watch <directory>
TraceMini start
TraceMini status
TraceMini repositories
TraceMini report
```

The CLI should be capable of running as a persistent background process/service.

---

## 9. Repository Discovery

The agent should not scan the entire computer indiscriminately.

Users explicitly configure directories to watch:

```bash
TraceMini watch ~/Projects
TraceMini watch ~/Work
```

The agent recursively searches those directories for Git repositories.

For every discovered repository it can obtain:

```bash
git remote -v
git branch
git rev-parse HEAD
git status
```

The local path is machine-specific and should not be used as the global repository identity.

The repository's remote URL is the primary identity.

Example:

```text
Ahmed:
~/Projects/visiogen
git@github.com:company/visiogen.git

Ali:
D:\Work\visiogen
git@github.com:company/visiogen.git
```

TraceMini treats these as the same repository within the same workspace.

---

## 10. Git Activity Tracking

TraceMini tracks meaningful development activity rather than every Git command.

### Tracked events

- Staging changes
- Commits
- Branch changes
- Pushes
- Pulls
- Merges

### Not tracked

Commands such as:

```text
git status
git log
git branch
git diff
```

are not meaningful activity by themselves and should not generate events.

---

## 11. Detecting Commits

Commits can be detected through:

- A local `post-commit` Git hook
- Repository state polling as a fallback

Commit activity should contain:

```text
commit SHA
commit message
branch
timestamp
files changed
insertions
deletions
```

---

## 12. Detecting Pushes

A `post-push` Git hook can notify the TraceMini agent.

Example:

```text
git push
   ↓
post-push hook
   ↓
TraceMini Agent
   ↓
push activity event
   ↓
TraceMini Backend
```

TraceMini does not need to know which Git hosting provider receives the push.

---

## 13. Detecting Staging

Git does not provide a normal post-stage hook.

The agent can therefore monitor the Git index:

```text
.git/index
```

When it changes, the agent can inspect:

```bash
git diff --cached
```

and generate a staging activity event.

Staging events do not need to capture every individual `git add` command. They should represent meaningful changes to the staged state.

---

## 14. Detecting Branches and Merges

Branch changes can be detected through:

- `post-checkout`
- `post-merge`
- repository state inspection

A merge can be represented as:

```text
type = merge
source_branch
target_branch
merge_commit
timestamp
```

This provides useful development information without requiring any external Git-hosting integration.

---

## 15. Pull Requests

TraceMini does not communicate with GitHub/GitLab/etc.

Therefore external PR state cannot be automatically synchronized.

The initial MVP should simply omit PR tracking.

If desired later, TraceMini can support explicit local commands such as:

```bash
TraceMini pr create --title "Improve note resizing"
TraceMini pr merge --branch feature/resizing
```

These would represent TraceMini-local activity records rather than synchronized GitHub/GitLab pull requests.

---

## 16. Multiple Contributors on One Repository

This is a normal use case.

Suppose three users have local clones of:

```text
git@github.com:company/visiogen.git
```

Each local TraceMini agent reports activity with its TraceMini user ID.

The backend therefore receives:

```text
Ahmed → Visiogen → commit A
Ali   → Visiogen → commit B
Usman → Visiogen → commit C
```

All events belong to the same repository record but remain attributed to their respective TraceMini users.

The TraceMini user identity is the primary activity attribution.

Git author information can also be stored for reference.

---

## 17. Source Code Storage

TraceMini should **not store users' repositories or source code**.

The server stores:

- Git metadata
- Activity events
- Report Markdown
- Workspace/account data

The user's source code remains on their machine.

This is intentional.

---

## 18. Local Code Analysis

When generating a report, the TraceMini CLI can access the actual repositories locally.

Example:

```text
TraceMini Web
   │
   │ Generate report for Aug 21
   ▼
TraceMini Backend
   │
   │ Report job
   ▼
TraceMini Agent
   │
   ├── retrieves activity
   ├── identifies relevant repositories
   ├── identifies commits/files/diffs
   │
   ▼
Local repository
   │
   ▼
Codex CLI / Hermes CLI
   │
   ▼
Markdown report
   │
   ▼
TraceMini Backend
   │
   ▼
TraceMini Web
```

Source code does not need to leave the user's machine.

---

## 19. Codex / Hermes Integration

TraceMini should not implement a direct API integration with Codex or Hermes.

Instead, the TraceMini CLI should invoke the user's installed CLI tool.

Possible configuration:

```yaml
reporter:
  type: codex
```

or:

```yaml
reporter:
  type: hermes
```

The TraceMini agent prepares the relevant context and invokes the configured CLI.

The result is Markdown.

TraceMini only needs to store/display that Markdown.

This keeps the AI integration loosely coupled.

---

## 20. Report Generation

### Personal report

Personal reports should be the first report feature implemented.

Example request:

```text
Generate report
From: 2026-08-20
To:   2026-08-20
```

The backend creates a report job.

The local TraceMini agent periodically checks for pending jobs.

The agent:

1. Retrieves the user's activity for the requested range.
2. Determines which repositories were involved.
3. Determines relevant commits and changed files.
4. Provides relevant Git information to Codex/Hermes.
5. Allows the local AI to inspect the repository.
6. Receives Markdown.
7. Uploads the Markdown to TraceMini.

---

## 21. Give the AI Git Context

The AI should not blindly read the entire repository.

The TraceMini agent should provide information such as:

```text
Repository: Visiogen
Period: 2026-08-20

Commit:
abc123
"Fix note text positioning"

Changed files:
src/shapes/Note.ts
src/render/TextRenderer.ts

Commit:
def456
"Add automatic note resizing"

Changed files:
src/shapes/Note.ts
src/render/ShapeRenderer.ts
```

Relevant diffs can also be provided.

This gives Codex/Hermes a focused starting point.

The AI can then inspect the actual local files when necessary.

---

## 22. Team Reports

Team reports are a later feature.

Do not make one user's local AI inspect other users' repositories.

Instead:

```text
Ahmed Agent → Ahmed report
Ali Agent   → Ali report
Usman Agent → Usman report
                     ↓
                 TraceMini Backend
                     ↓
               combined summary
```

The first implementation should therefore prioritize personal reports.

A future team report can combine individual reports and summarize them.

---

## 23. Report Jobs Without a Queue

For the project's scale, a normal database table is enough.

Example:

```text
report_jobs
------------------------------
id
user_id
start_date
end_date
status
created_at
completed_at
```

Possible statuses:

```text
pending
running
completed
failed
```

The TraceMini agent can poll for pending jobs every few seconds.

No Redis, RabbitMQ, Kafka, or worker cluster is necessary.

---

## 24. Connectivity Model

The TraceMini agent maintains an outbound connection to the TraceMini backend.

The backend does not need to connect to users' machines.

This avoids:

- Firewall configuration
- Port forwarding
- Public local endpoints
- Direct server-to-PC connections

For MVP simplicity, the agent can use:

```text
HTTP REST + periodic polling
```

A WebSocket connection can be added later if the dashboard needs instant updates.

---

## 25. Security Scope

Even though this is an internal 4–6 person application, basic security should still exist.

At minimum:

- HTTPS when deployed
- Password hashing if using password authentication
- Authenticated API requests
- Per-user workspace authorization
- Agent authentication tokens
- Do not expose local source code through the agent API
- Do not allow arbitrary commands from the backend to execute locally

Most importantly, report jobs should have a constrained purpose:

```text
"Generate a report using this user's configured local repositories."
```

The backend should not become a generic remote command executor.

---

## 26. Deployment

A simple deployment is enough:

```text
VPS
│
├── TraceMini Web
├── TraceMini Backend
└── SQLite database
```

The TraceMini agent runs on each developer's machine.

No container orchestration is required.

If desired, web and backend can initially even be the same application/process.

---

## 27. Recommended Technology Shape

The exact stack is flexible, but a simple implementation could be:

```text
Frontend:
React / Svelte / Next.js

Backend:
Node.js + TypeScript

Database:
SQLite

CLI:
Node.js + TypeScript

Communication:
REST/HTTP

Local Git integration:
git CLI + Git hooks + filesystem watching/polling

AI:
User-installed Codex CLI or Hermes CLI

Report format:
Markdown
```

The important part is not the exact framework. The important part is keeping the architecture small.

---

## 28. Core Design Principles

### Principle 1 — Local source code stays local

TraceMini stores metadata and reports, not repositories.

### Principle 2 — No external integrations

TraceMini communicates only with:

```text
TraceMini Backend
TraceMini CLI
```

The CLI communicates with:

```text
local Git
local filesystem
local Codex/Hermes
TraceMini Backend
```

### Principle 3 — Track meaningful activity

Do not turn TraceMini into command telemetry.

### Principle 4 — Prefer polling over infrastructure

For 4–6 users, simple polling is sufficient.

### Principle 5 — Database-backed jobs are enough

No message broker is necessary.

### Principle 6 — Personal reports first

Team reports can be built from individual reports later.

### Principle 7 — Repository identity is remote-based

Multiple local clones of the same remote repository map to one TraceMini repository within a workspace.

---

## 29. End-to-End Example

Ahmed joins the `Visiogen` workspace.

He runs:

```bash
TraceMini login
TraceMini join VSG-82KF
TraceMini watch ~/Projects
TraceMini start
```

TraceMini discovers:

```text
~/Projects/visiogen
```

with:

```text
origin = git@github.com:company/visiogen.git
```

Ahmed works normally:

```bash
git add src/shapes/Note.ts
git commit -m "Fix note positioning"
git push origin feature/note-positioning
```

TraceMini records:

```text
Ahmed
  ↓
Visiogen
  ↓
staging
  ↓
commit
  ↓
push
```

Later Ahmed clicks:

```text
Generate Report
August 21
```

TraceMini creates a report job.

His local agent picks it up.

The agent examines the relevant commits and local files, invokes Codex/Hermes, receives Markdown, and uploads the report.

TraceMini then displays:

```text
# Ahmed — Development Report
## August 21, 2026

...

```

At no point does TraceMini need access to GitHub or a copy of Ahmed's source code.
