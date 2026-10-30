# TraceMini

TraceMini helps small development teams see what they worked on and turn that work into useful reports.

**[Open TraceMini →](https://tracemini.vercel.app)**

Connect your Git repositories, work as usual, and review your activity in a shared dashboard. When you need an update, TraceMini uses your installed Codex or Hermes CLI to help write it.

Built for a small team of 4–6 developers, with a ready-to-use web app and a lightweight Linux agent on each developer’s machine. You can use the public app or host your own instance.

## What you can do

- **See recent work.** Browse Git activity by teammate, repository, or date.
- **Follow a development journey.** Open **Journey** to see the last 14 days of recorded activity for a person or project. Day blocks preview recorded commit messages and Git activity; select a day for its evidence. In Person view, choose **General** for one chain across all projects or **By project** for separate collapsible chains. Switch between 7 and 14 days or collapse a chain without reloading data. Quiet days mean no events have synced, not that no work took place. Day details show up to 500 recent events; counts cover the full fortnight. Use **Refresh journey** to retrieve newer activity.
- **Choose what gets tracked.** Pick the folders to scan and the repositories to include.
- **Write reports faster.** Generate a short bullet-point update or a detailed report, then download it as Markdown.
- **Include work outside Git.** Add notes, PDFs, or presentations for context about reviews, research, and other work.
- **Make updates routine.** Managers can schedule reports and optionally send them to Slack.

TraceMini stores activity information and generated reports. It does not upload your repositories or original context documents to the TraceMini server. Report generation uses the AI CLI installed on your machine.

## Start using TraceMini

1. Open [tracemini.vercel.app](https://tracemini.vercel.app), create an account, and create a workspace or accept an invitation from your team.
2. Open **Install CLI** in the web app and run the generated command on your Linux machine.
3. Choose the folders containing your projects. You can skip this and add folders later.
4. In **Settings**, select the repositories you want to track.
5. Work normally, then open the dashboard to see your activity.

The installer needs Node.js 22+, Git, a working systemd user session, and `sudo`/APT access. Windows and macOS installation are not supported yet.

To add a folder later:

```bash
tracemini watch "$HOME/projects"
```

Use `tracemini status` to check your connection or `tracemini --help` for available commands.

## Generate a report

Open **Reports**, choose a date range and writing style, and request a report. Your connected machine needs an installed, signed-in Codex or Hermes CLI to generate it.

Reports are instructed to group related activity into substantive contributions, so splitting the same work into more commits should not earn more coverage. Commit counts and lines changed are not productivity measures. Local Git excerpts share a bounded allowance equally across contributors with available clones, then across their repositories and commits. Reports should qualify claims where evidence is incomplete; their length is not a measure of total effort or an engineer ranking.

You can attach up to five Markdown, text, PDF, or PowerPoint files to explain work that Git does not capture. Document processing uses Codex, so it needs to be available even if you use Hermes for the report itself.

Managers can also schedule recurring workspace reports. The schedule prefers a connected device belonging to the Manager who saved it. If that device is offline or generation fails, other workspace members’ connected devices are tried one at a time. Each device is tried once per report; the selected Codex or Hermes CLI must be installed and signed in on the fallback machine. Attempts move on after two minutes without device contact or five minutes without finishing. If untried devices are offline, the job waits for one to reconnect. Personal and manually requested reports still run on the requester’s devices.

Documents added under **Context for next report** apply to the next scheduled report only. Fallback devices receive the same structured document context and workspace activity metadata, with other members’ private local paths removed. Source repositories remain on their respective machines; available local clones can enrich the report.

Slack delivery status is shown on saved reports. If delivery fails, open the report and select **Retry Slack delivery** to send the saved content without regenerating it. The report owner or a workspace Manager can retry. Earlier reports show **status unknown** because delivery outcomes were not previously recorded; retrying those may post a duplicate. An interrupted delivery can be retried after a minute by refreshing the report. Regenerating a previously notified report leaves its updated content pending manual Slack delivery. Slack webhooks cannot guarantee duplicate-free delivery after an ambiguous network failure.

### Send scheduled reports to Nexus

The local agent can also send completed scheduled reports to a Nexus chat as plain text. Headings, lists, links, and repository names remain readable without Markdown or Slack formatting; long reports are sent in numbered parts. Manual reports are not forwarded. Slack delivery continues to use the schedule's existing Slack setting.

On the machine generating the reports, create `~/.tracemini/nexus.env` (or `$TRACEMINI_HOME/nexus.env` if you use a custom agent directory):

```dotenv
NEXUS_CHAT_TOKEN=your-nexus-chat-token
NEXUS_CHAT_CONVERSATION_ID=25
```

Run `chmod 600 ~/.tracemini/nexus.env` to restrict access. The agent reads this file when sending a scheduled report; these settings belong on the local machine and do not need to be configured in Vercel. Process environment variables with the same names take precedence. The repository's `.env.local` alone does not configure the installed agent.

Nexus delivery happens after the report is saved and Slack delivery is attempted. Temporary network/server errors get one retry with the same idempotency key. If delivery still fails, the report stays saved and the agent logs the error (`journalctl --user -u tracemini.service`); there is no automatic catch-up after a sustained outage.

## Optional: run your own instance

You’ll need Node.js 22+, npm 10+, Git, and a PostgreSQL database. The example configuration uses Supabase.

```bash
npm ci
cp -n .env.example .env.local
```

Set `DATABASE_URL` in `.env.local` to your database connection string, then run:

```bash
npm run build
npm start -w @tracemini/server
```

Open [localhost:3000](http://localhost:3000) and create your account. See [.env.example](.env.example) for configuration options, including optional Slack notifications.

## Development

The project uses TypeScript, React/Vite, Express, and PostgreSQL. The web app lives in `apps/web`, the server in `apps/server`, and the local agent in `packages/cli`.

Run the checks before submitting code changes:

```bash
npm test
npm run typecheck
npm run build
npm run acceptance
```

See [AGENTS.md](AGENTS.md) for the project’s scope and contribution guidelines.
