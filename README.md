# TraceMini

TraceMini is a small self-hosted activity dashboard plus a local Git agent for 4–6 developers. The server stores accounts, Git metadata, activity, jobs, and Markdown reports in SQLite. Source code and local clone paths stay on each developer's machine.

## Requirements

- Node.js 22 (tested with 22.23.2), npm 10+, and Git
- Optional for generated reports: an authenticated `codex` or `hermes` executable on the agent machine

## Install, verify, and run

```bash
nvm install 22
nvm use 22
npm install
npm test
npm run typecheck
npm run build
npm run acceptance
npm start -w @tracemini/server
```

The built Express process serves both the API and `apps/web/dist` at `http://localhost:3000`. It uses `PORT=3000` and `TRACEMINI_DB=./data/tracemini.db` by default. For development, run `npm run dev -w @tracemini/server` and `npm run dev -w @tracemini/web` in separate terminals; the single-process shape applies to the production build.

## First workspace and agent

Register in the web UI and create a workspace. The register/login HTTP response contains the simple user bearer token needed to bootstrap the agent. Build and link the CLI once on each developer machine:

```bash
npm run build -w @tracemini/cli
npm link ./packages/cli
tracemini login --server http://localhost:3000 --token USER_BEARER_TOKEN
tracemini use-workspace WORKSPACE_ID
tracemini watch /absolute/path/to/explicit/watch/root
tracemini status
tracemini start
```

A joining user runs `tracemini join INVITE_CODE` after login, then `watch` and `start`. `watch` recursively discovers repositories only beneath the explicit root, requires an `origin`, registers clones, and installs hooks. Configuration, agent credentials, retry queue, and watched paths live in `~/.tracemini` with user-only file permissions. `TRACEMINI_HOME` overrides that directory.

## Events and hooks

Supported installed hooks are `post-commit`, `post-checkout`, `post-merge`, `post-rewrite`, and `pre-push`. An existing hook is moved once to `<hook>.tracemini-original`, and the wrapper executes it first. Explicit recording supports automation and operations Git cannot confirm with a client hook:

```bash
tracemini event --repo /path/to/repo --type commit
tracemini event --repo /path/to/repo --type branch
tracemini event --repo /path/to/repo --type merge
tracemini event --repo /path/to/repo --type push
tracemini event --repo /path/to/repo --type pull
tracemini event --repo /path/to/repo --type stage
```

The running agent polls registered Git indexes and emits debounced staged-state events. It flushes the JSON retry queue, sends heartbeats, and polls personal report jobs.

## Reports

Request a date range and Codex or Hermes in the web UI. The agent claims the job, fetches activity metadata, adds bounded `git show --stat` evidence for relevant local commits, and runs the local executable in the involved clone. Commands are based on installed CLI help:

- Codex: `codex exec --ephemeral --sandbox read-only --ask-for-approval never -C <clone> -`
- Hermes: `hermes --oneshot <prompt> --safe-mode`

The resulting Markdown is stored in report history and rendered in the UI. No diff or source file is sent to the server.

## Test coverage

`npm test` uses a real in-memory SQLite database through the real Express app and creates a temporary real Git repository. It covers two-user membership, workspace isolation, normalized clone grouping, event deduplication, report transitions, recursive discovery, staged/commit metadata, and chained-hook preservation.

`npm run acceptance` starts the compiled server with temporary SQLite, creates two users and two local clones, drives the CLI, creates a real commit through the installed `post-commit` hook, verifies grouped activity, and exercises claim/context/complete/report-history flow. It completes the report with deterministic Markdown instead of spending an external AI invocation.

## Deferred / limitations

- Team reports are deliberately omitted, as allowed by the plan.
- Git has no supported client-side `post-push`; `pre-push` records an attempt, not confirmed success. Use explicit `event --type push` after success when confirmation matters.
- Pulls have no dedicated hook. A merging pull appears as `post-merge`; use explicit `event --type pull` when the distinction matters. Fast-forward pulls are not independently inferred.
- Commit polling fallback is not implemented; hooks are the MVP mechanism. Index polling runs only while `tracemini start` runs.
- Hooks require `tracemini` on `PATH`. A failing pre-existing hook stops the wrapper before TraceMini, preserving chained-hook semantics.
- Background operation is a foreground process. systemd/Windows startup packaging and automatic startup are deferred.
- Repositories without `origin` are skipped because identity is remote-based.
- The JSON queue does not support concurrent agents sharing one `TRACEMINI_HOME`.
- The UI refreshes on navigation/filter changes, caps activity at 500 events, and has lightweight drill-down rather than production analytics.
- Codex/Hermes subprocess construction is implemented from installed help, but authenticated paid model execution is not run by deterministic tests. Missing tools, timeouts, and failures mark jobs failed.
- HTTPS belongs at a deployment reverse proxy. Password reset, invite rotation, session expiry, service installers, and production hardening are deferred.
