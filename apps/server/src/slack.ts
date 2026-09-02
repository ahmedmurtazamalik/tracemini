export type SlackReport = {
  id: number;
  workspaceId: number;
  workspaceName: string;
  name: string;
  startDate: string;
  endDate: string;
  scope: string;
  markdown: string;
};

function escaped(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMrkdwn(value: string) {
  const tokens: string[] = [];
  const keep = (text: string) => `\u0000${tokens.push(text) - 1}\u0000`;
  let output = value
    .replace(/!\[([^\]]*)]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) => keep(`<${escaped(url)}|${escaped(alt || 'Image')}>`))
    .replace(/\[([^\]]+)]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => keep(`<${escaped(url)}|${escaped(label)}>`))
    .replace(/`([^`]+)`/g, (_match, code) => keep(`\`${escaped(code)}\``))
    .replace(/\*\*([^*]+)\*\*/g, (_match, text) => keep(`*${escaped(text)}*`))
    .replace(/__([^_]+)__/g, (_match, text) => keep(`*${escaped(text)}*`))
    .replace(/~~([^~]+)~~/g, (_match, text) => keep(`~${escaped(text)}~`))
    .replace(/\*([^*]+)\*/g, (_match, text) => keep(`_${escaped(text)}_`));
  output = escaped(output);
  return output.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

export function markdownToSlackMrkdwn(markdown: string) {
  const output: string[] = [];
  let inCodeBlock = false;
  let inTable = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const tableLine = /^\s*\|.*\|\s*$/.test(line);
    if (tableLine && !inCodeBlock) {
      if (!inTable) { output.push('```'); inTable = true; }
      output.push(escaped(line));
      continue;
    }
    if (inTable) { output.push('```'); inTable = false; }
    if (/^\s*```/.test(line)) {
      output.push('```');
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) { output.push(escaped(line)); continue; }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (heading) { output.push(`*${inlineMrkdwn(heading[1])}*`); continue; }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { output.push('──────────'); continue; }
    const task = /^\s*[-*+]\s+\[([ xX])]\s+(.+)$/.exec(line);
    if (task) { output.push(`${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${inlineMrkdwn(task[2])}`); continue; }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) { output.push(`• ${inlineMrkdwn(bullet[1])}`); continue; }
    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (ordered) { output.push(`${ordered[1]}. ${inlineMrkdwn(ordered[2])}`); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { output.push(`> ${inlineMrkdwn(quote[1])}`); continue; }
    output.push(inlineMrkdwn(line));
  }
  if (inTable) output.push('```');
  if (inCodeBlock) output.push('```');
  return output.join('\n').trim();
}

export function slackReportRange(startDate: string, endDate: string) {
  const display = (value: string) => new Intl.DateTimeFormat('en-US', {month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'}).format(new Date(`${value}T00:00:00Z`));
  return startDate === endDate ? display(startDate) : `${display(startDate)} – ${display(endDate)}`;
}

export function chunkSlackMrkdwn(text: string, limit = 2_900) {
  const chunks: string[] = [];
  let current = '';
  let inCodeBlock = false;
  for (const originalLine of text.split('\n')) {
    const lines = originalLine.length <= limit - 8 ? [originalLine] : originalLine.match(new RegExp(`.{1,${limit - 8}}`, 'g')) || [''];
    for (const line of lines) {
      const addition = `${current ? '\n' : ''}${line}`;
      if (current && current.length + addition.length > limit - (inCodeBlock ? 4 : 0)) {
        chunks.push(inCodeBlock ? `${current}\n\`\`\`` : current);
        current = inCodeBlock ? '```' : '';
      }
      current += `${current ? '\n' : ''}${line}`;
      if (line.trim() === '```') inCodeBlock = !inCodeBlock;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendSlackReport(webhookUrl: string, report: SlackReport) {
  const scope = report.scope === 'workspace' ? 'Workspace report' : 'Personal report';
  const range = slackReportRange(report.startDate, report.endDate);
  const reportBlocks = chunkSlackMrkdwn(markdownToSlackMrkdwn(report.markdown));
  if (reportBlocks.length > 45) throw new Error('Report is too long for one Slack message');
  const blocks = [
    {type: 'header', text: {type: 'plain_text', text: report.name.slice(0, 150)}},
    {type: 'context', elements: [{type: 'mrkdwn', text: `*Workspace:* ${escaped(report.workspaceName)}  •  *Range:* ${range}  •  *Type:* ${scope}`}]},
    {type: 'divider'},
    ...reportBlocks.map(text => ({type: 'section', text: {type: 'mrkdwn', text}})),
  ];
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text: `${report.name} — ${report.workspaceName} — ${range}`, blocks}),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
}
