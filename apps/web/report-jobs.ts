export type ReportJobStatus = {id?: number; status: string; error?: string};

type PollOptions = {
  intervalMs?: number;
  maxAttempts?: number;
  wait?: (milliseconds: number) => Promise<unknown>;
  isActive?: () => boolean;
  onStatus?: (status: ReportJobStatus) => void;
};

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForReportJob<T extends ReportJobStatus>(
  jobId: number,
  fetchStatus: (jobId: number) => Promise<T>,
  options: PollOptions = {},
): Promise<T | undefined> {
  const intervalMs = options.intervalMs ?? 1500;
  const maxAttempts = options.maxAttempts ?? 120;
  const wait = options.wait ?? sleep;
  const isActive = options.isActive ?? (() => true);
  let latest: T | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!isActive()) return undefined;
    latest = await fetchStatus(jobId);
    if (!isActive()) return undefined;
    options.onStatus?.(latest);
    if (latest.status !== 'pending' && latest.status !== 'running') return latest;
    if (attempt + 1 < maxAttempts) await wait(intervalMs);
  }
  return latest!;
}
