const shortRef = (value: unknown) => String(value || '')
  .replace(/^refs\/(?:heads|tags)\//, '')
  .replace(/^refs\/remotes\//, '');

const shortSha = (value: unknown) => String(value || '').slice(0, 8);

export function activitySummary(event: {type: string; data?: Record<string, unknown>}) {
  const data = event.data || {};
  if (event.type === 'push') {
    const destination = shortRef(data.ref);
    const target = [data.remote, destination && `→ ${destination}`].filter(Boolean).join(' ');
    return [target, data.confirmation || 'unconfirmed'].filter(Boolean).join(' · ');
  }
  if (event.type === 'commit') return [data.message, data.branch].filter(Boolean).join(' · ');
  if (event.type === 'stage') {
    const count = Number(data.filesChanged);
    const files = Number.isFinite(count) ? `${count} ${count === 1 ? 'file' : 'files'}` : '';
    return [files, data.branch].filter(Boolean).join(' · ');
  }
  if (event.type === 'branch') return String(data.branch || '');
  if (event.type === 'pull' || event.type === 'merge' || event.type === 'rewrite') {
    return [data.branch, shortSha(data.commitSha)].filter(Boolean).join(' · ');
  }
  return String(data.message || data.branch || shortRef(data.ref) || '');
}
