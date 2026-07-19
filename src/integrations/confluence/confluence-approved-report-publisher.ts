import { z } from 'zod';
import {
  ReportPublicationProviderError,
  type ApprovedReportDocument,
  type ApprovedReportPublisher,
  type PublishedReportPage,
} from '../../application/ports/approved-report-publisher.js';
import { INCIDENT_REPORT_SECTION_TYPES } from '../../application/report/incident-report.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REPORT_CHARACTERS = 200_000;
const MAX_STORAGE_BODY_BYTES = 512 * 1024;
const MAX_PAGE_TITLE_CHARACTERS = 255;

const confluenceIdSchema = z.string().regex(/^[1-9][0-9]{0,29}$/u);
const cloudIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u);
const confluencePageSchema = z
  .object({
    id: confluenceIdSchema,
    status: z.literal('current'),
    title: z.string().min(1).max(MAX_PAGE_TITLE_CHARACTERS),
    spaceId: confluenceIdSchema,
    _links: z.object({ webui: z.string().min(1).max(2_000) }).passthrough(),
  })
  .passthrough();
const confluencePageListSchema = z
  .object({
    results: z.array(confluencePageSchema).max(2),
    _links: z
      .object({ next: z.string().min(1).max(2_000).optional() })
      .passthrough(),
  })
  .passthrough();

const SECTION_HEADINGS = {
  executive_summary: 'Executive summary',
  impact: 'Impact',
  detection: 'Detection',
  timeline: 'Timeline',
  root_cause: 'Root cause',
  contributing_factors: 'Contributing factors',
  mitigation_and_recovery: 'Mitigation and recovery',
  what_went_well: 'What went well',
  what_did_not_go_well: 'What did not go well',
  follow_up_recommendations: 'Follow-up recommendations',
} as const;

export interface ConfluenceApprovedReportPublisherOptions {
  readonly baseUrl: string;
  readonly cloudId?: string;
  readonly email: string;
  readonly apiToken: string;
  readonly spaceId: string;
  readonly parentPageId?: string;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Creates one complete Confluence Cloud page in an explicitly scoped space. */
export class ConfluenceApprovedReportPublisher implements ApprovedReportPublisher {
  public readonly provider = 'CONFLUENCE' as const;

  private readonly siteUrl: URL;
  private readonly apiOrigin: URL;
  private readonly apiPathPrefix: string;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly spaceId: string;
  private readonly parentPageId: string | undefined;
  private readonly authorization: string;

  public constructor(options: ConfluenceApprovedReportPublisherOptions) {
    this.siteUrl = parseConfluenceSiteUrl(options.baseUrl);
    if (options.cloudId === undefined) {
      this.apiOrigin = this.siteUrl;
      this.apiPathPrefix = '';
    } else {
      const cloudId = cloudIdSchema.parse(options.cloudId);
      this.apiOrigin = new URL('https://api.atlassian.com');
      this.apiPathPrefix = `/ex/confluence/${cloudId}`;
    }
    const email = z.email().max(254).parse(options.email.trim());
    const apiToken = z
      .string()
      .min(1)
      .max(4_096)
      .regex(/^[!-~]+$/u)
      .parse(options.apiToken);
    this.authorization = `Basic ${Buffer.from(
      `${email}:${apiToken}`,
      'utf8',
    ).toString('base64')}`;
    this.spaceId = confluenceIdSchema.parse(options.spaceId);
    this.parentPageId =
      options.parentPageId === undefined
        ? undefined
        : confluenceIdSchema.parse(options.parentPageId);
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new Error('Confluence timeout must be at least one second');
    }
  }

  public async publish(
    document: ApprovedReportDocument,
  ): Promise<PublishedReportPage> {
    const title = pageTitle(document);
    const existing = await this.findExistingPage(title);
    if (existing !== null) {
      return existing;
    }

    try {
      const page = confluencePageSchema.parse(
        await this.requestJson('/wiki/api/v2/pages', {
          method: 'POST',
          body: JSON.stringify({
            spaceId: this.spaceId,
            status: 'current',
            title,
            ...(this.parentPageId === undefined
              ? {}
              : { parentId: this.parentPageId }),
            body: {
              representation: 'storage',
              value: renderStorageBody(document),
            },
          }),
        }),
      );
      return this.toPublishedPage(page);
    } catch (error) {
      if (
        error instanceof ReportPublicationProviderError &&
        error.code === 'CONFLUENCE_CONFLICT'
      ) {
        const racedPage = await this.findExistingPage(title);
        if (racedPage !== null) {
          return racedPage;
        }
      }
      throw error;
    }
  }

  private async findExistingPage(
    title: string,
  ): Promise<PublishedReportPage | null> {
    const url = this.apiUrl(`/wiki/api/v2/spaces/${this.spaceId}/pages`);
    url.searchParams.set('title', title);
    url.searchParams.set('status', 'current');
    url.searchParams.set('limit', '2');
    const response = confluencePageListSchema.parse(
      await this.requestJson(url, { method: 'GET' }),
    );
    if (response._links.next !== undefined || response.results.length > 1) {
      throw new ReportPublicationProviderError(
        'CONFLUENCE_DUPLICATE_INCIDENT_PAGE',
      );
    }
    const page = response.results[0];
    if (page === undefined) {
      return null;
    }
    if (page.title !== title || page.spaceId !== this.spaceId) {
      throw new ReportPublicationProviderError(
        'CONFLUENCE_UNEXPECTED_QUERY_RESULT',
      );
    }
    return this.toPublishedPage(page);
  }

  private async requestJson(
    pathOrUrl: string | URL,
    init: { readonly method: 'GET' | 'POST'; readonly body?: string },
  ): Promise<unknown> {
    const url =
      typeof pathOrUrl === 'string' ? this.apiUrl(pathOrUrl) : pathOrUrl;
    if (
      url.origin !== this.apiOrigin.origin ||
      !url.pathname.startsWith(`${this.apiPathPrefix}/wiki/api/v2/`) ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      throw new ReportPublicationProviderError('CONFLUENCE_INVALID_API_URL');
    }

    let response: Response;
    try {
      response = await this.request(url, {
        method: init.method,
        headers: {
          accept: 'application/json',
          authorization: this.authorization,
          ...(init.body === undefined
            ? {}
            : { 'content-type': 'application/json; charset=utf-8' }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ReportPublicationProviderError(
        'CONFLUENCE_NETWORK_ERROR',
        null,
        { cause: error },
      );
    }

    const responseBody = await readBoundedJson(response);
    if (!response.ok) {
      throw new ReportPublicationProviderError(
        confluenceErrorCode(response.status),
        response.status === 429 ? parseRetryAfter(response.headers) : null,
      );
    }
    return responseBody;
  }

  private toPublishedPage(
    page: z.infer<typeof confluencePageSchema>,
  ): PublishedReportPage {
    const pageUrl = new URL(page._links.webui, this.siteUrl);
    if (
      pageUrl.origin !== this.siteUrl.origin ||
      !pageUrl.pathname.startsWith('/wiki/') ||
      pageUrl.username !== '' ||
      pageUrl.password !== '' ||
      pageUrl.search !== '' ||
      pageUrl.hash !== ''
    ) {
      throw new ReportPublicationProviderError('CONFLUENCE_INVALID_PAGE_URL');
    }
    return { pageId: page.id, pageUrl: pageUrl.toString() };
  }

  private apiUrl(path: string): URL {
    if (!path.startsWith('/wiki/api/v2/')) {
      throw new ReportPublicationProviderError('CONFLUENCE_INVALID_API_PATH');
    }
    return new URL(`${this.apiPathPrefix}${path}`, this.apiOrigin);
  }
}

function parseConfluenceSiteUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.atlassian.net') ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'Confluence site URL must be a plain HTTPS atlassian.net origin',
    );
  }
  return url;
}

function pageTitle(document: ApprovedReportDocument): string {
  const suffix = ` · ${document.incidentId}`;
  const prefix = 'Incident report — ';
  const maximumIncidentTitleCharacters =
    MAX_PAGE_TITLE_CHARACTERS - [...prefix, ...suffix].length;
  const normalizedTitle = document.title.trim().replace(/\s+/gu, ' ');
  const incidentTitle = [...normalizedTitle]
    .slice(0, maximumIncidentTitleCharacters)
    .join('');
  return `${prefix}${incidentTitle || 'Untitled incident'}${suffix}`;
}

function renderStorageBody(document: ApprovedReportDocument): string {
  const reportCharacterCount = document.sections.reduce(
    (total, section) =>
      total +
      section.statements.reduce(
        (sectionTotal, statement) => sectionTotal + statement.text.length,
        0,
      ),
    0,
  );
  if (reportCharacterCount > MAX_REPORT_CHARACTERS) {
    throw new ReportPublicationProviderError('CONFLUENCE_REPORT_TOO_LARGE');
  }

  const sections = new Map(
    document.sections.map((section) => [section.sectionType, section]),
  );
  const sectionMarkup = INCIDENT_REPORT_SECTION_TYPES.map((sectionType) => {
    const section = sections.get(sectionType);
    const statements =
      section === undefined || section.statements.length === 0
        ? '<p><em>No reviewed information is included.</em></p>'
        : `<ul>${section.statements
            .map((statement) => {
              const classification = classificationLabel(
                statement.classification,
              );
              return `<li>${
                classification === ''
                  ? ''
                  : `<strong>${escapeStorageText(classification)}:</strong> `
              }${escapeStorageText(statement.text)}</li>`;
            })
            .join('')}</ul>`;
    return `<h2>${SECTION_HEADINGS[sectionType]}</h2>${statements}`;
  }).join('');

  const body = [
    '<p><strong>Final human-approved incident report</strong></p>',
    '<table><tbody>',
    metadataRow('Incident', document.title),
    metadataRow('Severity', document.severity),
    metadataRow('Revision', String(document.revisionNumber)),
    metadataRow('Approved', document.approvedAt.toISOString()),
    metadataRow('Incident reference', document.incidentId),
    '</tbody></table>',
    sectionMarkup,
  ].join('');
  if (Buffer.byteLength(body, 'utf8') > MAX_STORAGE_BODY_BYTES) {
    throw new ReportPublicationProviderError(
      'CONFLUENCE_STORAGE_BODY_TOO_LARGE',
    );
  }
  return body;
}

function metadataRow(label: string, value: string): string {
  return `<tr><th>${escapeStorageText(label)}</th><td>${escapeStorageText(value)}</td></tr>`;
}

function escapeStorageText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function classificationLabel(
  classification: ApprovedReportDocument['sections'][number]['statements'][number]['classification'],
): string {
  switch (classification) {
    case 'human_confirmed':
      return 'Human confirmed';
    case 'hypothesis':
      return 'Hypothesis';
    case 'correlated_inference':
      return 'Correlated inference';
    case 'participant_assertion':
      return 'Participant assertion';
    case 'disputed':
      return 'Disputed';
    case 'unknown':
      return 'Unknown';
    case 'directly_observed':
    case 'corroborated':
      return '';
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ReportPublicationProviderError('CONFLUENCE_RESPONSE_TOO_LARGE');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new ReportPublicationProviderError('CONFLUENCE_INVALID_JSON', null, {
      cause: error,
    });
  }
}

function confluenceErrorCode(status: number): string {
  switch (status) {
    case 401:
      return 'CONFLUENCE_AUTHENTICATION_FAILED';
    case 403:
      return 'CONFLUENCE_FORBIDDEN';
    case 404:
      return 'CONFLUENCE_NOT_FOUND';
    case 409:
      return 'CONFLUENCE_CONFLICT';
    case 413:
      return 'CONFLUENCE_REPORT_TOO_LARGE';
    case 429:
      return 'CONFLUENCE_RATE_LIMITED';
    default:
      return status >= 500
        ? 'CONFLUENCE_SERVER_ERROR'
        : `CONFLUENCE_HTTP_${status}`;
  }
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,5}$/u.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}
