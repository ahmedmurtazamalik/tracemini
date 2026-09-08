# TraceMini

TraceMini helps small development teams see what they worked on and turn that work into useful reports.

**[Open TraceMini →](https://tracemini.vercel.app)**

Connect your Git repositories, work as usual, and review your activity in a shared dashboard. When you need an update, TraceMini uses your installed Codex or Hermes CLI to help write it.

Built for a small team of 4–6 developers, with a ready-to-use web app and a lightweight Linux agent on each developer’s machine. You can use the public app or host your own instance.

## What you can do

- **See recent work.** Browse Git activity by teammate, repository, or date.
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

You can attach up to five Markdown, text, PDF, or PowerPoint files to explain work that Git does not capture. Document processing uses Codex, so it needs to be available even if you use Hermes for the report itself.

Managers can also schedule recurring reports. Documents added under **Context for next report** apply to the next scheduled report only. The machine responsible for generating the report needs to be online.

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
