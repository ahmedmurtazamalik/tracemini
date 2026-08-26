export type SlackReport = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  scope: string;
};

export async function sendSlackReport(webhookUrl: string, report: SlackReport & {workspaceId: number}, origin: string) {
  const link = `${origin}/workspaces/${report.workspaceId}/reports/${report.id}`;
  const scope = report.scope === 'workspace' ? 'Workspace report' : 'Personal report';
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text: `${scope} ready: ${report.name}\n${report.startDate} to ${report.endDate}\n${link}`}),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
}
