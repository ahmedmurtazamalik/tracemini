---
name: tracemini
description: Answer questions about authenticated TraceMini workspaces, Git activity, team timelines, and reports using the read-only TraceMini MCP tools.
---

# TraceMini

Use the `tracemini` MCP tools to answer questions grounded in the user's own TraceMini data. Start with `tracemini_workspaces` when the workspace ID is unknown. Use `tracemini_dashboard` for activity and totals, `tracemini_timeline` for team time series, and the report tools for existing reports. A date range may span at most 90 days. Dates use `YYYY-MM-DD`; pass the user's timezone when known.

If a tool says sign-in is needed, explain that the user can run `node plugins/tracemini/scripts/login.mjs` from a TraceMini checkout in their own terminal. Never ask them to paste a password or session token in chat. Do not inspect or reveal the saved session file. The plugin is read-only and does not create reports, alter workspace settings, or install the TraceMini device agent.

Report timestamps and the selected timezone when freshness matters. Missing activity is not proof that work did not happen: TraceMini only sees repositories selected on connected devices, and reports may include context outside Git. Summarize from returned data without inventing events or treating document context as completed work.
