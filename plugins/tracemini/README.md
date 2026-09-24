# TraceMini for Codex

This read-only plugin lets Codex answer questions about your TraceMini workspaces, Git activity, team timelines, and existing reports. Each person signs in with their own TraceMini account, and the TraceMini API checks their workspace membership on every request.

## Install from GitHub

While the upstream pull request is under review, install from the public fork branch:

```bash
codex plugin marketplace add alimajidneo/tracemini --ref codex/tracemini-plugin
codex plugin add tracemini@tracemini
```

After the pull request is merged, new users can add `ahmedmurtazamalik/tracemini --ref main` instead. Start a new Codex task after installing so it loads the new skill and tools.

## Sign in

In a TraceMini checkout, run:

```bash
node plugins/tracemini/scripts/login.mjs
```

The command prompts for your TraceMini email and password in the terminal, sends them directly to the TraceMini API over HTTPS, and saves only the returned session token in a mode-0600 file under `~/.config/tracemini-codex/session.json`. It never asks Codex to handle your password. Use `--server https://your-tracemini-host` for a self-hosted instance or `--logout` to remove the session. The GitHub marketplace installs a copy of the plugin; you can also run the login script from that installed plugin folder.

## Available tools

- `tracemini_workspaces` lists accessible workspaces.
- `tracemini_dashboard` reads filtered activity, repositories, totals, and a team timeline.
- `tracemini_timeline` reads team activity buckets for up to 90 days.
- `tracemini_reports` lists existing reports in a workspace.
- `tracemini_report` reads one existing report.

The tools do not create reports, change workspace settings, or install the TraceMini device agent. Results are bounded to protect the Codex context window. There is no background polling.

## Public directory status

This GitHub marketplace is a way to share the plugin with other Codex users. It is not a listing in the universal public Plugins Directory. A public listing also requires a hosted HTTPS MCP endpoint with user-bound OAuth, a verified publisher and domain, a submission through the OpenAI Platform, review, and a final Publish action. The local MCP server in this package is not suitable for public directory submission by itself. See [official OpenAI submission guidance](https://developers.openai.com/plugins/deploy/submission).
