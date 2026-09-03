export type LocalContextDocument = {
  localId: string;
  workspaceId: number;
  displayName: string;
  format: 'pdf' | 'pptx';
  mediaType: string;
  byteSize: number;
  sha256?: string;
  pageOrSlideCount: number;
  consentedAt: string;
  metadata: {title: string; shortSummary: string; [key: string]: unknown};
};

const endpoint = 'http://127.0.0.1:43127';
const unavailable = 'The local TraceMini document agent is not reachable on port 43127. Run `systemctl --user restart tracemini.service`, or use Connect or sync this device in Settings, then try again.';
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export const localAgentFetch = async (
  path: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<unknown> = pause,
) => {
  let response: Response;
  const retryable = !init.method || init.method.toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      response = await request(`${endpoint}${path}`, {...init, mode: 'cors'});
      break;
    } catch {
      // Installation and credential sync restart the service. Give systemd a
      // brief window to bind the loopback port before declaring it unavailable.
      if (!retryable || attempt >= 2) throw new Error(unavailable);
      await wait(250 * (attempt + 1));
    }
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Local TraceMini document analysis failed.');
  return body;
};

export async function localDocumentStatus() {
  return localAgentFetch('/v1/status');
}

export async function listLocalDocuments(workspaceId: number): Promise<LocalContextDocument[]> {
  return localAgentFetch(`/v1/documents?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export async function deriveLocalDocument(file: File, workspaceId: number): Promise<LocalContextDocument> {
  const status = await localDocumentStatus();
  return localAgentFetch('/v1/documents/derive-metadata', {
    method: 'POST', body: file,
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-tracemini-file-name': encodeURIComponent(file.name),
      'x-tracemini-workspace': String(workspaceId),
      'x-tracemini-consent': 'true',
      'x-tracemini-nonce': status.nonce,
    },
  });
}

export async function deleteLocalDocument(localId: string) {
  const status = await localDocumentStatus();
  return localAgentFetch(`/v1/documents/${encodeURIComponent(localId)}`, {method: 'DELETE', headers: {'x-tracemini-nonce': status.nonce}});
}

export function hostedDocument(document: LocalContextDocument) {
  const {localId: _localId, workspaceId: _workspaceId, sha256: _sha256, ...metadata} = document;
  return metadata;
}

export const documentIdentity = (document: Pick<LocalContextDocument, 'displayName' | 'consentedAt'>) => `${document.displayName}\0${document.consentedAt}`;
