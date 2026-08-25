export type DownloadableReport = {
  id: number;
  name?: string;
  start_date: string;
  end_date: string;
  markdown: string;
};

export function buildReportDownload(report: DownloadableReport) {
  const safeDate = (value: string) => value.replace(/[^0-9-]/g, '').slice(0, 10) || 'undated';
  const safeName = report.name?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const filename = safeName
    ? `tracemini-${safeName}.md`
    : `tracemini-report-${safeDate(report.start_date)}-to-${safeDate(report.end_date)}.md`;
  return {
    filename,
    contents: `${report.markdown.replace(/\s+$/, '')}\n`,
    mimeType: 'text/markdown;charset=utf-8',
  };
}

export function downloadReport(report: DownloadableReport) {
  const download = buildReportDownload(report);
  const url = URL.createObjectURL(new Blob([download.contents], {type: download.mimeType}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
