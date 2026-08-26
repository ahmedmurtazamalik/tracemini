export type RepositoryCandidate = {
  id: number;
  agent_id: number;
  owner_user_id?: number;
  owner_name?: string;
  machine_name: string;
  local_key?: string;
  name: string;
  normalized_remote: string;
  branch?: string;
  traced: boolean;
  desired_traced: boolean;
  last_seen: string;
  error?: string;
};

export function repositorySelectionState(candidate: RepositoryCandidate) {
  if (candidate.error && candidate.desired_traced !== candidate.traced) {
    return {
      label: candidate.desired_traced ? 'Could not start tracing' : 'Could not stop tracing',
      pending: false,
      checked: candidate.desired_traced,
      tone: 'error',
    } as const;
  }
  if (candidate.desired_traced !== candidate.traced) {
    return {
      label: candidate.desired_traced ? 'Starting…' : 'Stopping…',
      pending: true,
      checked: candidate.desired_traced,
      tone: 'progress',
    } as const;
  }
  return candidate.traced
    ? {label: 'Traced', pending: false, checked: true, tone: 'success'} as const
    : {label: 'Available', pending: false, checked: false, tone: 'muted'} as const;
}
