export const DOCUMENT_CONTEXT_KIND = 'tracemini-report-context';
export const SCHEDULE_STATE_KIND = 'tracemini-schedule-state';
export const MAX_DOCUMENTS = 5;
export const MAX_DOCUMENT_METADATA_BYTES = 4 * 1024;
export const MAX_REPORT_DOCUMENT_BYTES = 12 * 1024;

export type DocumentMetadata = {
  displayName: string;
  format: 'pdf' | 'pptx';
  mediaType: string;
  byteSize: number;
  pageOrSlideCount: number;
  consentedAt: string;
  metadata: {
    title: string;
    shortSummary: string;
    keyPoints: Array<{text: string; references: string[]}>;
    decisions: Array<{text: string; references: string[]}>;
    actionItems: Array<{text: string; owner?: string; dueDate?: string; references: string[]}>;
    projects: string[];
    people: string[];
    relevantDates: string[];
    warnings: string[];
  };
};

export type ReportContextEnvelope = {kind: typeof DOCUMENT_CONTEXT_KIND; version: 1; guidance: string | null; documents: DocumentMetadata[]};

const text = (value: unknown, name: string, limit = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /(?:file:\/\/|(?:^|\s)(?:\/[\w.-]+){2,}|[a-z]:\\|\\\\)/i.test(value)) throw new Error(`invalid document ${name}`);
  return value.trim();
};
const list = (value: unknown, name: string, limit: number) => {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`invalid document ${name}`);
  return value.map((entry, index) => text(entry, `${name}[${index}]`, 240));
};
const referenced = (value: unknown, name: string, limit: number) => {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`invalid document ${name}`);
  return value.map((entry: any, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`invalid document ${name}[${index}]`);
    const allowed = name === 'actionItems' ? ['text', 'owner', 'dueDate', 'references'] : ['text', 'references'];
    if (Object.keys(entry).some(key => !allowed.includes(key))) throw new Error(`invalid document ${name}[${index}]`);
    return {
      text: text(entry.text, `${name}[${index}].text`, 500),
      ...(name === 'actionItems' && entry.owner ? {owner: text(entry.owner, `${name}[${index}].owner`, 120)} : {}),
      ...(name === 'actionItems' && entry.dueDate ? {dueDate: text(entry.dueDate, `${name}[${index}].dueDate`, 80)} : {}),
      references: list(entry.references, `${name}[${index}].references`, 8),
    };
  });
};

export function validateDocumentMetadata(value: unknown): DocumentMetadata {
  const document: any = value;
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid document metadata');
  const allowed = ['displayName', 'format', 'mediaType', 'byteSize', 'pageOrSlideCount', 'consentedAt', 'metadata'];
  if (Object.keys(document).some(key => !allowed.includes(key))) throw new Error('invalid document metadata field');
  if (!['pdf', 'pptx'].includes(document.format)) throw new Error('invalid document format');
  const expectedMediaType = document.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (document.mediaType !== expectedMediaType) throw new Error('invalid document media type');
  if (!Number.isInteger(document.byteSize) || document.byteSize < 1 || document.byteSize > 25 * 1024 * 1024) throw new Error('invalid document byte size');
  if (!Number.isInteger(document.pageOrSlideCount) || document.pageOrSlideCount < 1 || document.pageOrSlideCount > (document.format === 'pdf' ? 100 : 200)) throw new Error('invalid document page or slide count');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(document.consentedAt || '') || !Number.isFinite(Date.parse(document.consentedAt))) throw new Error('invalid document consent time');
  const metadata = document.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid document summary');
  const metadataKeys = ['title', 'shortSummary', 'keyPoints', 'decisions', 'actionItems', 'projects', 'people', 'relevantDates', 'warnings'];
  if (Object.keys(metadata).some(key => !metadataKeys.includes(key)) || metadataKeys.some(key => !(key in metadata))) throw new Error('invalid document summary field');
  const normalized: DocumentMetadata = {
    displayName: text(document.displayName, 'display name', 160),
    format: document.format,
    mediaType: text(document.mediaType, 'media type', 100),
    byteSize: document.byteSize,
    pageOrSlideCount: document.pageOrSlideCount,
    consentedAt: new Date(document.consentedAt).toISOString(),
    metadata: {
      title: text(metadata.title, 'title', 240),
      shortSummary: text(metadata.shortSummary, 'summary', 1000),
      keyPoints: referenced(metadata.keyPoints, 'keyPoints', 12) as any,
      decisions: referenced(metadata.decisions, 'decisions', 8) as any,
      actionItems: referenced(metadata.actionItems, 'actionItems', 8) as any,
      projects: list(metadata.projects, 'projects', 12),
      people: list(metadata.people, 'people', 20),
      relevantDates: list(metadata.relevantDates, 'relevantDates', 12),
      warnings: list(metadata.warnings, 'warnings', 8),
    },
  };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_DOCUMENT_METADATA_BYTES) throw new Error('document metadata exceeds 4 KiB');
  return normalized;
}

export function validateDocumentContext(value: unknown): DocumentMetadata[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) throw new Error('documentContext must contain at most five documents');
  const documents = value.map(validateDocumentMetadata);
  if (Buffer.byteLength(JSON.stringify(documents)) > MAX_REPORT_DOCUMENT_BYTES) throw new Error('document context exceeds 12 KiB');
  return documents;
}

export function encodeReportContext(guidance: string | null, documents: DocumentMetadata[]) {
  if (!documents.length) return guidance;
  return JSON.stringify({kind: DOCUMENT_CONTEXT_KIND, version: 1, guidance, documents} satisfies ReportContextEnvelope);
}

export function decodeReportContext(value: unknown): {guidance: string | null; documents: DocumentMetadata[]} {
  if (typeof value !== 'string' || !value.trim()) return {guidance: null, documents: []};
  try {
    const parsed = JSON.parse(value);
    if (parsed?.kind !== DOCUMENT_CONTEXT_KIND || parsed?.version !== 1) return {guidance: value.trim(), documents: []};
    const guidance = parsed.guidance == null ? null : text(parsed.guidance, 'guidance', 4000);
    return {guidance, documents: validateDocumentContext(parsed.documents)};
  } catch (error) {
    if (value.trimStart().startsWith('{')) throw error;
    return {guidance: value.trim(), documents: []};
  }
}

export function encodeScheduleDays(days: number[], documents: DocumentMetadata[]) {
  return documents.length ? {kind: SCHEDULE_STATE_KIND, version: 1, days, documentContext: documents} : days;
}

export function decodeScheduleDays(value: unknown): {days: number[]; documents: DocumentMetadata[]} {
  const parsed: any = typeof value === 'string' ? JSON.parse(value) : value;
  if (Array.isArray(parsed)) return {days: parsed.map(Number), documents: []};
  if (parsed?.kind !== SCHEDULE_STATE_KIND || parsed?.version !== 1 || !Array.isArray(parsed.days)) throw new Error('invalid stored schedule state');
  return {days: parsed.days.map(Number), documents: validateDocumentContext(parsed.documentContext)};
}
