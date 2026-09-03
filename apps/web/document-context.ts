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
const localFetch = async (path: string, init: RequestInit = {}) => {
  let response: Response;
  try { response = await fetch(`${endpoint}${path}`, {...init, mode: 'cors'}); }
  catch { throw new Error('The local TraceMini document agent is not running on port 43127. Start or update the TraceMini agent, then try again.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Local TraceMini document analysis failed.');
  return body;
};

export async function localDocumentStatus() {
  return localFetch('/v1/status');
}

export async function listLocalDocuments(workspaceId: number): Promise<LocalContextDocument[]> {
  return localFetch(`/v1/documents?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export async function deriveLocalDocument(file: File, workspaceId: number): Promise<LocalContextDocument> {
  const status = await localDocumentStatus();
  return localFetch('/v1/documents/derive-metadata', {
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
  return localFetch(`/v1/documents/${encodeURIComponent(localId)}`, {method: 'DELETE', headers: {'x-tracemini-nonce': status.nonce}});
}

export function hostedDocument(document: LocalContextDocument) {
  const {localId: _localId, workspaceId: _workspaceId, sha256: _sha256, ...metadata} = document;
  return metadata;
}

export const documentIdentity = (document: Pick<LocalContextDocument, 'displayName' | 'consentedAt'>) => `${document.displayName}\0${document.consentedAt}`;
