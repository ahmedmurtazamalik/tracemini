export type SlackReport = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  scope: string;
  summary: string;
};

export function slackReportSummary(markdown: string) {
  const lines: string[] = [];
  let inCodeBlock = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock || !line || /^#{1,6}\s/.test(line) || /^\|?\s*:?-{3}/.test(line) || /^\|/.test(line)) continue;
    const cleaned = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/!\[[^\]]*]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/[*_~`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) lines.push(cleaned);
  }
  const selected: string[] = [];
  let length = 0;
  for (const line of lines) {
    const remaining = 320 - length;
    if (remaining < 40 || selected.length === 2) break;
    selected.push(line.length > remaining ? `${line.slice(0, remaining - 1).trimEnd()}…` : line);
    length += selected.at(-1)!.length;
  }
  return selected.join('\n') || 'The report is ready for review.';
}

export async function sendSlackReport(webhookUrl: string, report: SlackReport & {workspaceId: number}, origin: string) {
  const link = `${origin}/workspaces/${report.workspaceId}/reports/${report.id}`;
  const scope = report.scope === 'workspace' ? 'Workspace report' : 'Personal report';
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text: `${scope} ready: ${report.name}\n${report.startDate} to ${report.endDate}\n\n${report.summary}\n\n${link}`}),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
}
