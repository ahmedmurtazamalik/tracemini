export type DownloadableReport = {
  id: number;
  start_date: string;
  end_date: string;
  markdown: string;
};

export function buildReportDownload(report: DownloadableReport) {
  const safeDate = (value: string) => value.replace(/[^0-9-]/g, '').slice(0, 10) || 'undated';
  return {
    filename: `tracemini-report-${safeDate(report.start_date)}-to-${safeDate(report.end_date)}.md`,
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
