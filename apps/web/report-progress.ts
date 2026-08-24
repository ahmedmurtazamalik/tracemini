export type ReportJob = {id?: number; status: 'pending' | 'running' | 'completed' | 'failed'; error?: string | null};

export function reportJobProgress(job: ReportJob) {
  if (job.status === 'pending') return {active: true, tone: 'progress', label: 'Waiting for a connected device…'} as const;
  if (job.status === 'running') return {active: true, tone: 'progress', label: 'Generating report on your device…'} as const;
  if (job.status === 'failed') return {active: false, tone: 'error', label: `Report failed${job.error ? `: ${job.error}` : '.'}`} as const;
  return {active: false, tone: 'success', label: 'Report completed.'} as const;
}
