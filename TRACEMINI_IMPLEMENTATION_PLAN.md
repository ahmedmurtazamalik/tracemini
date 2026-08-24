# TraceMini — Implementation Plan

## 1. Implementation Philosophy

TraceMini is intentionally a small system for 4–6 users.

The implementation should follow this rule:

> Build the simplest thing that reliably demonstrates the complete TraceMini workflow.

Do not introduce infrastructure until the application actually requires it.

Initial architecture:

```text
TraceMini Web
    ↓
TraceMini Backend
    ↓
Supabase-hosted PostgreSQL via `DATABASE_URL` (direct backend `pg` access; Data API disabled)
    ↑
TraceMini CLI/Agent
    ↓
Local Git repositories
    ↓
Codex/Hermes
```

---

# Phase 0 — Repository and Project Setup

## Goals

Create the project structure and establish the basic development environment.

Suggested monorepo:

```text
TraceMini/
├── apps/
│   ├── web/
│   └── server/
│
├── packages/
│   ├── shared/
│   └── cli/
│
├── database/
├── docs/
├── package.json
└── README.md
```

Possible simpler alternative:

```text
TraceMini/
├── web/
├── server/
├── cli/
└── shared/
```

Choose whichever keeps development easiest.

### Tasks

- [ ] Create Git repository
- [ ] Set up TypeScript
- [ ] Set up frontend
- [ ] Set up backend
- [ ] Set up CLI package
- [ ] Set up shared types
- [x] Set up the versioned PostgreSQL schema, advisory migration lock, and isolated pg-mem tests (no SQLite data migration or persistent volume)
- [ ] Add environment configuration
- [ ] Add basic development scripts
- [ ] Write initial README

---

# Phase 1 — Database and Backend Foundation

## Goal

Create the backend API and core database model.

### Database tables

Implement:

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

### Tasks

- [ ] Create database schema
- [ ] Add migrations
- [ ] Implement user model
- [ ] Implement workspace model
- [ ] Implement workspace membership
- [ ] Implement repository model
- [ ] Implement activity event model
- [ ] Implement report job model
- [ ] Implement report model
- [ ] Add basic validation

---

# Phase 2 — Authentication

## Goal

Allow users to create accounts and authenticate.

### Tasks

- [ ] Registration
- [ ] Login
- [ ] Logout
- [ ] Session/token handling
- [ ] Password hashing if using password authentication
- [ ] Auth middleware
- [ ] Current-user endpoint

Keep authentication simple.

Do not build OAuth providers because TraceMini intentionally has no external integrations.

---

# Phase 3 — Workspace System

## Goal

Allow users to create and join workspaces.

### User flow

```text
Register
   ↓
Create workspace
   ↓
Receive invite code
```

Another user:

```text
Register/Login
   ↓
Enter invite code
   ↓
Join workspace
```

### Tasks

- [ ] Create workspace endpoint
- [ ] Generate invite code
- [ ] Join workspace endpoint
- [ ] Validate invite code
- [ ] List user's workspaces
- [ ] Workspace member list
- [ ] Basic workspace permissions

---

# Phase 4 — TraceMini CLI Authentication

## Goal

Connect a local CLI installation to a TraceMini account.

Example:

```bash
TraceMini login
```

Possible flow:

```text
TraceMini login
    ↓
user receives device/auth code
    ↓
browser opens TraceMini
    ↓
user authenticates
    ↓
CLI receives agent token
```

For an even simpler MVP, the CLI can accept a generated token:

```bash
TraceMini login --token <token>
```

The exact authentication UX can be improved later.

### Tasks

- [ ] CLI project
- [ ] CLI configuration directory
- [ ] Login command
- [ ] Secure-ish local token storage
- [ ] Agent registration
- [ ] `TraceMini status`
- [ ] Backend agent authentication

---

# Phase 5 — Repository Discovery

## Goal

Find Git repositories on the user's machine.

The user explicitly chooses directories:

```bash
TraceMini watch ~/Projects
TraceMini watch ~/Work
```

The agent recursively searches for `.git`.

### Tasks

- [ ] Implement `TraceMini watch`
- [ ] Store watched directories locally
- [ ] Scan for `.git`
- [ ] Identify repository root
- [ ] Read repository name
- [ ] Read remote URL
- [ ] Read current branch
- [ ] Register repository with TraceMini
- [ ] Avoid duplicate repository registrations

Example local configuration:

```json
{
  "watched_paths": [
    "/home/user/Projects"
  ]
}
```

---

# Phase 6 — Repository Identity

## Goal

Correctly identify multiple local clones of the same repository.

Use normalized remote URL as the primary identity.

Example:

```text
git@github.com:company/visiogen.git
https://github.com/company/visiogen.git
```

These may need normalization so that equivalent URLs map to the same repository.

At minimum:

- [ ] Normalize remote URLs
- [ ] Store remote URL
- [ ] Store repository name
- [ ] Associate repository with workspace
- [ ] Associate local clone/agent with repository

Do not use local filesystem paths as repository identity.

---

# Phase 7 — Git Activity Tracking

This is the core TraceMini functionality.

Implement activity tracking incrementally.

## 7.1 Commit tracking

Use a `post-commit` hook.

Example:

```text
.git/hooks/post-commit
        ↓
TraceMini Agent
        ↓
read commit metadata
        ↓
send activity event
```

Record:

```text
commit SHA
message
branch
timestamp
files changed
insertions
deletions
```

Tasks:

- [ ] Install post-commit hook
- [ ] Detect commits
- [ ] Extract commit metadata
- [ ] Create activity event
- [ ] Send event to backend
- [ ] Prevent duplicate events

---

## 7.2 Push tracking

Use `post-push`.

Record:

```text
remote
branch/ref
commit range if available
timestamp
```

Tasks:

- [ ] Install post-push hook
- [ ] Parse push information
- [ ] Send push event
- [ ] Prevent duplicate events

TraceMini does not need to contact the remote server.

---

## 7.3 Branch tracking

Use `post-checkout`.

Record:

```text
old branch/commit
new branch/commit
branch name
timestamp
```

Tasks:

- [ ] Install post-checkout hook
- [ ] Determine branch
- [ ] Record branch switch
- [ ] Send activity event

---

## 7.4 Merge tracking

Use `post-merge`.

Record:

```text
branch
merge commit
timestamp
```

Tasks:

- [ ] Install post-merge hook
- [ ] Detect merge
- [ ] Record merge event

---

## 7.5 Staging tracking

Git does not have a normal post-stage hook.

Use filesystem observation of:

```text
.git/index
```

When it changes:

```text
.git/index changed
       ↓
git diff --cached
       ↓
determine staged state
       ↓
send staging activity
```

Do not generate a new event for every tiny change.

Debounce changes for a short period.

For example:

```text
index changes
    ↓
wait 1–2 seconds
    ↓
inspect final staged state
```

Tasks:

- [ ] Monitor `.git/index`
- [ ] Debounce changes
- [ ] Run `git diff --cached`
- [ ] Determine staged files
- [ ] Record staging event
- [ ] Avoid event spam

---

# Phase 8 — Activity API

Implement backend endpoints for activity.

Example:

```text
POST /api/activity
GET  /api/workspaces/:id/activity
GET  /api/repositories/:id/activity
GET  /api/users/:id/activity
```

The backend should validate:

- authenticated agent
- agent's user
- user's workspace membership
- repository ownership/association

Tasks:

- [ ] Activity ingestion endpoint
- [ ] Activity query endpoints
- [ ] Date filtering
- [ ] User filtering
- [ ] Repository filtering
- [ ] Event pagination if needed

For 4–6 users, simple pagination is enough.

---

# Phase 9 — Dashboard

## Goal

Make the activity visible.

Build:

### Workspace dashboard

```text
Today
────────────────────────

Ahmed       6 commits
Ali         4 commits
Usman       7 commits

Recent Activity
────────────────────────

09:42 Ahmed
Fix note positioning

09:51 Ali
Update validation

10:13 Ahmed
Pushed feature/note-resizing
```

### Repository page

```text
Visiogen

Contributors
Ahmed
Ali
Usman

Recent activity
...
```

### User page

```text
Ahmed

Today
6 commits
3 pushes
11 files changed

Activity
...
```

Tasks:

- [ ] Workspace dashboard
- [ ] Activity feed
- [ ] Repository page
- [ ] User activity page
- [ ] Date filters
- [ ] Repository filters
- [ ] Basic statistics

Do not overbuild analytics.

---

# Phase 10 — Agent Reliability Basics

Before reports, make the agent reasonably reliable.

Implement:

- [ ] Agent startup
- [ ] Background service support
- [ ] Repository rescan
- [ ] Network retry
- [ ] Local event buffering
- [ ] Duplicate-event protection
- [ ] Agent heartbeat/last-seen
- [ ] Basic local logs
- [ ] `TraceMini status`

A simple local event buffer is useful:

```text
~/.TraceMini/
    config.json
    credentials
    queue.json
    logs/
```

If the network is temporarily unavailable:

```text
Git event
   ↓
local queue
   ↓
network available
   ↓
send events
```

Do not turn this into a distributed event system. A simple local queue is enough.

---

# Phase 11 — Report Job System

## Goal

Allow the web app to request a report from a user's local agent.

Flow:

```text
User clicks "Generate Report"
            ↓
Backend creates report_job
            ↓
status = pending
            ↓
Agent polls
            ↓
Agent claims job
            ↓
status = running
```

### Tasks

- [ ] Create report job table
- [ ] Create report request endpoint
- [ ] Agent job polling
- [ ] Job claiming
- [ ] Job status updates
- [ ] Completion handling
- [ ] Failure handling

Example endpoints:

```text
POST /api/reports/jobs
GET  /api/agents/jobs
POST /api/reports/jobs/:id/complete
POST /api/reports/jobs/:id/fail
```

---

# Phase 12 — Local Report Context

The TraceMini agent needs to build useful context for the AI.

For a requested date range:

```text
2026-08-20 → 2026-08-21
```

the agent asks TraceMini for the user's activity.

Example:

```text
Visiogen

Commits:
abc123 "Fix note positioning"
def456 "Add automatic resizing"

Changed files:
src/shapes/Note.ts
src/render/TextRenderer.ts
src/render/ShapeRenderer.ts

Branches:
feature/note-positioning

Pushes:
2
```

The agent can then run Git commands locally:

```bash
git show abc123
git show def456
git diff <commit-range>
```

Tasks:

- [ ] Fetch activity for report range
- [ ] Group activity by repository
- [ ] Identify commits
- [ ] Identify changed files
- [ ] Generate relevant Git diffs
- [ ] Build AI context
- [ ] Limit unnecessary repository scanning

---

# Phase 13 — Codex/Hermes Runner

Create a small abstraction:

```text
ReportRunner
├── CodexRunner
└── HermesRunner
```

Interface concept:

```text
generateReport(context, repositoryPaths)
    -> markdown
```

The TraceMini CLI invokes the configured local executable.

Example conceptual configuration:

```json
{
  "reporter": {
    "type": "codex"
  }
}
```

or:

```json
{
  "reporter": {
    "type": "hermes"
  }
}
```

Tasks:

- [ ] Define report runner interface
- [ ] Implement Codex runner
- [ ] Implement Hermes runner
- [ ] Pass Git/activity context
- [ ] Allow local repository inspection
- [ ] Capture Markdown output
- [ ] Handle process errors
- [ ] Enforce reasonable execution timeout

The exact CLI arguments should be determined from the installed Codex/Hermes CLI rather than hard-coded into the architecture.

---

# Phase 14 — Personal Reports

## Goal

Complete the first major AI feature.

UI:

```text
Reports

[ Generate Report ]

From: [2026-08-21]
To:   [2026-08-21]

Reporter:
(o) Codex
( ) Hermes
```

Flow:

```text
TraceMini Web
   ↓
Report Job
   ↓
TraceMini Agent
   ↓
Activity retrieval
   ↓
Local Git analysis
   ↓
Codex/Hermes
   ↓
Markdown
   ↓
TraceMini
   ↓
Report page
```

Tasks:

- [ ] Report creation UI
- [ ] Date range selection
- [ ] Reporter selection
- [ ] Report job creation
- [ ] Agent execution
- [ ] Markdown upload
- [ ] Report storage
- [ ] Report display
- [ ] Report history

---

# Phase 15 — Report Quality

Once the end-to-end pipeline works, improve the prompt/context rather than adding infrastructure.

A useful report structure might be:

```markdown
# Development Report

## Summary

## Repositories Worked On

## Major Changes

## Technical Details

## Commits

## Branches and Merges

## Files/Areas Modified

## Overall Progress
```

The prompt should instruct the local AI to:

- distinguish actual implementation from minor changes
- group related commits
- avoid merely listing commit messages
- explain technical changes
- avoid claiming work that cannot be supported by the Git/code context
- summarize the requested time range only

---

# Phase 16 — Team Reports

Only after personal reports work well.

The architecture should be:

```text
Ahmed Agent
    ↓
Ahmed report
    │
Ali Agent
    ↓
Ali report
    │
Usman Agent
    ↓
Usman report
    │
    ▼
TraceMini Backend
    ↓
Combined team report
```

The combined report should operate on individual reports, not source code.

Possible future flow:

```text
Generate Team Report
        ↓
collect completed personal reports
        ↓
combine Markdown
        ↓
summarize team progress
```

Tasks:

- [ ] Team report UI
- [ ] Generate/fetch member reports
- [ ] Combine reports
- [ ] Generate team summary
- [ ] Display team report

Do not make a user's local agent access another user's machine.

---

# Phase 17 — Background Service Packaging

Once functionality is stable, make the agent pleasant to use.

### Linux

Provide a systemd user service.

### Other platforms

Windows and macOS installation and background startup are deferred; the current implementation is Linux-only.

The desired experience is:

```bash
TraceMini start
```

followed by automatic background operation.

Tasks:

- [ ] Linux service
- [ ] Windows and macOS service/startup support (deferred)
- [ ] Automatic startup
- [ ] Clean shutdown
- [ ] Agent status command

---

# Phase 18 — Installation UX

The onboarding flow should eventually be:

```text
1. Create/join TraceMini workspace

2. Install TraceMini CLI

3. Run:

   TraceMini login

4. Run:

   TraceMini join <invite-code>

5. Configure directories:

   TraceMini watch ~/Projects

6. Start:

   TraceMini start
```

After that the user should not have to interact with the CLI regularly.

---

# Phase 19 — Testing

Testing should focus on the actual TraceMini workflow.

## Git tests

Test:

- [ ] New commit
- [ ] Multiple commits
- [ ] Staging
- [ ] Unstaging
- [ ] Branch creation
- [ ] Branch checkout
- [ ] Push
- [ ] Pull
- [ ] Merge
- [ ] Multiple repositories
- [ ] Multiple local clones

## Workspace tests

- [ ] Create workspace
- [ ] Join workspace
- [ ] Multiple users
- [ ] Repository shared by multiple users
- [ ] User isolation

## Agent tests

- [ ] Offline operation
- [ ] Reconnection
- [ ] Duplicate event handling
- [ ] Restart
- [ ] Repository rescan

## Reports

- [ ] Empty activity range
- [ ] One repository
- [ ] Multiple repositories
- [ ] Multiple commits
- [ ] Large diff
- [ ] Codex unavailable
- [ ] Hermes unavailable
- [ ] AI execution failure
- [ ] Network failure during upload

---

# Phase 20 — Final MVP

The first complete TraceMini version should support:

```text
✓ User accounts
✓ Workspaces
✓ Invite codes
✓ TraceMini CLI
✓ Agent registration
✓ Watched directories
✓ Git repository discovery
✓ Repository grouping
✓ Commit tracking
✓ Staging tracking
✓ Push tracking
✓ Pull tracking
✓ Branch tracking
✓ Merge tracking
✓ Activity dashboard
✓ Per-user activity
✓ Per-repository activity
✓ Personal reports
✓ Local Codex/Hermes execution
✓ Markdown report storage
✓ Markdown report display
```

It should explicitly not require:

```text
✗ GitHub API
✗ GitHub webhook
✗ GitLab API
✗ Bitbucket API
✗ Source-code upload
✗ Central repository cloning
✗ Redis
✗ Kafka
✗ RabbitMQ
✗ Kubernetes
✗ Distributed workers
```

---

# Recommended Development Order

If implementation time is limited, follow this exact sequence:

```text
1. Backend + PostgreSQL
        ↓
2. Authentication
        ↓
3. Workspace + invite codes
        ↓
4. CLI authentication
        ↓
5. Repository discovery
        ↓
6. Commit tracking
        ↓
7. Push tracking
        ↓
8. Branch/merge tracking
        ↓
9. Staging tracking
        ↓
10. Activity dashboard
        ↓
11. Agent background service
        ↓
12. Report jobs
        ↓
13. Local Git context generation
        ↓
14. Codex/Hermes runner
        ↓
15. Personal reports
        ↓
16. Testing/polish
        ↓
17. Team reports (optional)
```

This order ensures that every stage produces something demonstrable.

---

# Definition of Done for MVP

TraceMini can be considered functional when:

1. A user can create a workspace.
2. Another user can join using an invite code.
3. Both users can install the CLI.
4. Each CLI can register itself.
5. The CLI can discover their local repositories.
6. Two users' clones of the same remote repository are grouped together.
7. Git activity appears in TraceMini.
8. Activity is attributed to the correct user.
9. A user can select a date range.
10. TraceMini can request a report from their local agent.
11. The local agent can inspect the relevant repository.
12. Codex or Hermes can generate Markdown.
13. The Markdown is stored by TraceMini.
14. The report is viewable in the web app.

At that point, TraceMini already delivers its core value.

Everything after that is refinement.
