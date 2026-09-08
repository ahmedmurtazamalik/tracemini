# TraceMini Simplification Contract

TraceMini is an internal MVP for 4–6 developers. Its purpose is narrow: collect useful local Git activity, show a small web dashboard, and generate personal reports through an already-installed local Codex or Hermes CLI. Favor speed, directness, and maintainability by one developer.

This file governs all work in this repository. Read `README.md` and `TRACEMINI_SYSTEM_OVERVIEW.md` for product behavior, but do not treat old plans or accumulated implementation complexity as requirements. Preserve the workflows users actually need; simplify their implementation.

## Non-negotiable scope

Keep:

- A TypeScript CLI/local agent that observes explicitly watched Git roots.
- An Express API serving the built React/Vite UI.
- PostgreSQL metadata/report storage through the existing backend.
- Registration/login, workspaces, Manager/Member membership, repository selection, activity display, and personal reports.
- Local Codex/Hermes report generation without uploading source code.
- Linux as the only supported agent-install platform.

Do not add:

- Provider APIs or webhooks, source upload, Redis, queues, brokers, distributed workers, microservices, Kubernetes, enterprise audit infrastructure, browser automation, OAuth, team reports, or multi-platform installers.
- New frameworks, architectural layers, generic repositories/services, dependency injection, provider abstractions, feature flags, or configuration surfaces unless required by behavior in active use.
- Scalability or concurrency machinery for a four-person deployment without a reproduced problem.
- Security work beyond ordinary credential protection, authentication/authorization boundaries, parameterized database access, and safe handling of destructive actions and untrusted inputs.

## Current shape and likely pressure points

The repository currently has three main implementation concentrations:

- `apps/web/src.tsx` is about 1,700 lines.
- `apps/server/src/app.ts` is about 750 lines.
- `packages/cli/src/agent.ts` is about 590 lines.

It also has roughly 31 test files, including a 600+ line server suite and a 500+ line repository-selection agent suite. These facts identify audit targets, not automatic mandates to split files or delete tests. A smaller file count is not itself success; fewer concepts, faster feedback, and preserved workflows are.

## Required simplification workflow

### 1. Establish evidence first

Before editing:

- Record the current branch and working-tree state. Preserve all user changes.
- Time the cheapest available baseline for build, typecheck, the full test suite, server startup, and one representative app workflow. Do not spend more than 15 minutes obtaining baselines.
- Identify the slowest test files or startup paths using existing runner output or simple timing. Do not install a profiler unless basic timing is insufficient.
- Inspect production source, dependencies, and tests for duplication, obsolete compatibility paths, serial waits, repeated setup, unnecessary process spawning, and architecture that no current requirement uses.
- Write a short ranked list of no more than five changes. Each item must state expected payoff, behavior preserved, files affected, and verification.

Do not begin a broad rewrite based only on file length or aesthetics.

### 2. Simplify in payoff order

Prefer changes such as:

- Removing obsolete compatibility routes or code paths that are not part of the current documented workflow.
- Consolidating duplicated test setup and replacing redundant scenario matrices with representative cases.
- Removing tests for impossible states, unsupported platforms, implementation details, or third-party behavior.
- Eliminating unnecessary polling, fixed delays, repeated database setup, repeated builds, duplicate Git subprocesses, and sequential work when evidence shows they dominate runtime.
- Inlining one-use abstractions and deleting configuration or indirection with only one real implementation.
- Splitting a large file only when the split creates an obvious product boundary and reduces cognitive load; do not manufacture layers.

Do not change PostgreSQL, Express, React/Vite, or the TypeScript workspace layout merely to make the architecture look cleaner. Do not migrate frameworks or rewrite the application.

### 3. Preserve real behavior

Preserve the documented happy paths and realistic failure paths for:

- Authentication and workspace membership.
- Device ownership and agent credentials.
- Watching a Git root, repository discovery/selection, hooks, and activity ingestion.
- Dashboard/date-filter behavior.
- Creating, claiming, generating, storing, displaying, and downloading a personal report.

It is acceptable to remove accidental complexity, obsolete compatibility, and redundant defenses. Do not weaken authentication/authorization or expose credentials/source code in the name of speed.

If a behavior appears unused or contradictory, search for callers and documentation. Remove it only with concrete evidence; otherwise list it as a proposed follow-up.

## TraceMini testing budget

- Add no new test unless it protects a preserved happy path, reproduces a discovered regression, or covers a realistic data-loss/auth boundary.
- Do not preserve a test solely because it exists. Delete or combine tests that assert obsolete behavior, duplicate another test, inspect private implementation details, or model impossible scenarios.
- Prefer a few workflow tests plus focused pure-function tests over exhaustive endpoint/state matrices.
- While iterating, run only affected test files and typecheck the affected workspace.
- Run the full suite at most once after a coherent batch. Run build once at the end.
- Do not repeatedly run acceptance, hosted-database, network, installer, or systemd checks. Run them only if the changed path requires them and the environment is available.
- Hard limit for any single command: 15 minutes. Stop it, capture the evidence, and diagnose rather than waiting indefinitely.
- Hard limit for repeated substantially identical failures: two. Change approach or report the blocker.
- Do not chase 100% coverage or create tests to compensate for deleting code.

## Change-size guardrails

- Keep each batch coherent and reviewable.
- Every changed line must support simplification, measured performance, or preserved behavior.
- New production line count should normally be lower than deleted production line count during this task. If not, explain the concrete performance or clarity gain before proceeding.
- Adding a dependency, service, database table, build tool, framework, abstraction layer, or background process is out of scope unless the user explicitly approves it.
- Do not edit generated `dist` artifacts by hand or commit local database/runtime artifacts.
- Do not clean up unrelated code.

## Overnight execution and stop conditions

Work autonomously only while evidence supports the next change. Maintain a small progress note with baseline, completed batches, measurements, and remaining candidates.

Stop the task when any of these occurs:

- The ranked, evidence-backed candidates are complete.
- Performance no longer improves materially.
- The next step requires product judgment, removal of a documented workflow, schema migration, framework change, or new dependency.
- Verification depends on unavailable credentials, network services, hosted PostgreSQL, systemd, or interactive Codex/Hermes authentication.
- The same blocker persists after two distinct reasonable attempts.

Never fill the remaining night with speculative cleanup. A short, verified simplification is a successful run.

## Completion report

Report:

- Baseline and final timings using the same commands.
- Production/test lines or files removed, consolidated, or retained and why.
- User-visible workflows verified.
- Commands run, durations, and any checks skipped because they were irrelevant or unavailable.
- Concrete remaining bottlenecks ranked by measured impact.

Do not report speculative security or scale concerns unless they are demonstrated in the current four-person deployment.
