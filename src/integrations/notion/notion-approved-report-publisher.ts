import { z } from 'zod';
import {
  ReportPublicationProviderError,
  type ApprovedReportDocument,
  type ApprovedReportPublisher,
  type PublishedReportPage,
} from '../../application/ports/approved-report-publisher.js';
import { INCIDENT_REPORT_SECTION_TYPES } from '../../application/report/incident-report.js';

const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2026-03-11';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REPORT_CHARACTERS = 200_000;
const MAX_RICH_TEXT_CHARACTERS = 2_000;
const MAX_RICH_TEXT_ITEMS = 100;

const notionIdSchema = z
  .string()
  .trim()
  .regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu);
const notionPageSchema = z
  .object({
    object: z.literal('page'),
    id: notionIdSchema,
    url: z.url(),
    in_trash: z.boolean().optional().default(false),
  })
  .passthrough();
const queryResponseSchema = z
  .object({
    object: z.literal('list'),
    results: z.array(notionPageSchema).max(2),
    has_more: z.boolean(),
  })
  .passthrough();
const notionErrorSchema = z
  .object({ code: z.string().min(1).max(128) })
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

export interface NotionApprovedReportPublisherOptions {
  readonly apiToken: string;
  readonly dataSourceId: string;
  readonly titleProperty: string;
  readonly incidentIdProperty: string;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Creates one complete, private-by-inheritance Notion page per incident. */
export class NotionApprovedReportPublisher implements ApprovedReportPublisher {
  public readonly provider = 'NOTION' as const;

  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly dataSourceId: string;
  private readonly titleProperty: string;
  private readonly incidentIdProperty: string;

  public constructor(
    private readonly options: NotionApprovedReportPublisherOptions,
  ) {
    if (options.apiToken.length < 1 || options.apiToken.length > 4_096) {
      throw new Error('Notion API token is invalid');
    }
    this.dataSourceId = notionIdSchema.parse(options.dataSourceId);
    this.titleProperty = validatePropertyName(
      options.titleProperty,
      'Notion title property',
    );
    this.incidentIdProperty = validatePropertyName(
      options.incidentIdProperty,
      'Notion incident ID property',
    );
    if (this.titleProperty === this.incidentIdProperty) {
      throw new Error('Notion publication properties must be distinct');
    }
    this.request = options.request ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new Error('Notion timeout must be at least one second');
    }
  }

  public async publish(
    document: ApprovedReportDocument,
  ): Promise<PublishedReportPage> {
    const existing = await this.findExistingPage(document.incidentId);
    if (existing !== null) {
      return existing;
    }

    const page = notionPageSchema.parse(
      await this.requestJson('/pages', {
        parent: { type: 'data_source_id', data_source_id: this.dataSourceId },
        icon: { type: 'emoji', emoji: '🛡️' },
        properties: {
          [this.titleProperty]: {
            title: richText(`Incident report — ${document.title}`, 2_000),
          },
          [this.incidentIdProperty]: {
            rich_text: richText(document.incidentId, 2_000),
          },
        },
        children: renderPageBlocks(document),
      }),
    );
    return toPublishedPage(page);
  }

  private async findExistingPage(
    incidentId: string,
  ): Promise<PublishedReportPage | null> {
    const response = queryResponseSchema.parse(
      await this.requestJson(`/data_sources/${this.dataSourceId}/query`, {
        filter: {
          property: this.incidentIdProperty,
          rich_text: { equals: incidentId },
        },
        page_size: 2,
      }),
    );
    if (response.has_more || response.results.length > 1) {
      throw new ReportPublicationProviderError(
        'NOTION_DUPLICATE_INCIDENT_PAGE',
      );
    }
    const page = response.results[0];
    if (page === undefined) {
      return null;
    }
    if (page.in_trash) {
      throw new ReportPublicationProviderError('NOTION_INCIDENT_PAGE_IN_TRASH');
    }
    return toPublishedPage(page);
  }

  private async requestJson(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${NOTION_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json; charset=utf-8',
          'notion-version': NOTION_API_VERSION,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ReportPublicationProviderError('NOTION_NETWORK_ERROR', null, {
        cause: error,
      });
    }

    const responseBody = await readBoundedJson(response);
    if (!response.ok) {
      const parsedError = notionErrorSchema.safeParse(responseBody);
      const errorCode = parsedError.success
        ? notionErrorCode(parsedError.data.code)
        : `NOTION_HTTP_${response.status}`;
      throw new ReportPublicationProviderError(
        errorCode,
        response.status === 429 ? parseRetryAfter(response.headers) : null,
      );
    }
    return responseBody;
  }
}

function renderPageBlocks(document: ApprovedReportDocument): unknown[] {
  const reportCharacterCount = document.sections.reduce(
    (total, section) =>
      total +
      section.statements.reduce(
        (sectionTotal, statement) => sectionTotal + statement.text.length,
        0,
      ),
    document.questionAnswers.reduce(
      (total, answer) => total + answer.question.length + answer.answer.length,
      document.remainingOpenQuestions.reduce(
        (total, question) => total + question.length,
        0,
      ),
    ),
  );
  if (reportCharacterCount > MAX_REPORT_CHARACTERS) {
    throw new ReportPublicationProviderError('NOTION_REPORT_TOO_LARGE');
  }

  const blocks: unknown[] = [
    {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '✅' },
        rich_text: richText(
          [
            'Final human-approved incident report',
            `Severity: ${document.severity}`,
            `Revision: ${document.revisionNumber}`,
            `Approved: ${document.approvedAt.toISOString()}`,
            `Incident reference: ${document.incidentId}`,
          ].join('\n'),
        ),
        color: 'green_background',
      },
    },
    { object: 'block', type: 'divider', divider: {} },
  ];
  const sections = new Map(
    document.sections.map((section) => [section.sectionType, section]),
  );
  for (const sectionType of INCIDENT_REPORT_SECTION_TYPES) {
    const section = sections.get(sectionType);
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: richText(SECTION_HEADINGS[sectionType]) },
    });
    const content =
      section === undefined || section.statements.length === 0
        ? 'No reviewed information is included.'
        : section.statements
            .map(
              (statement) =>
                `• ${classificationLabel(statement.classification)}${statement.text}`,
            )
            .join('\n\n');
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText(content) },
    });
  }
  if (document.questionAnswers.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: richText('Reviewed questions and answers') },
    });
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: richText(
          document.questionAnswers
            .map(
              (answer, index) =>
                `${index + 1}. ${answer.question}\n${answer.answer}`,
            )
            .join('\n\n'),
        ),
      },
    });
  }
  if (document.remainingOpenQuestions.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: richText('Remaining open questions') },
    });
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: richText(
          document.remainingOpenQuestions
            .map((question) => `• ${question}`)
            .join('\n\n'),
        ),
      },
    });
  }
  if (blocks.length > 100) {
    throw new ReportPublicationProviderError('NOTION_TOO_MANY_BLOCKS');
  }
  return blocks;
}

function richText(
  value: string,
  maximumCharacters = Number.MAX_SAFE_INTEGER,
): unknown[] {
  const characters = [...value.trim()].slice(0, maximumCharacters);
  const items: unknown[] = [];
  for (
    let index = 0;
    index < characters.length;
    index += MAX_RICH_TEXT_CHARACTERS
  ) {
    items.push({
      type: 'text',
      text: {
        content: characters
          .slice(index, index + MAX_RICH_TEXT_CHARACTERS)
          .join(''),
      },
    });
  }
  if (items.length === 0) {
    items.push({ type: 'text', text: { content: 'Untitled incident' } });
  }
  if (items.length > MAX_RICH_TEXT_ITEMS) {
    throw new ReportPublicationProviderError('NOTION_RICH_TEXT_TOO_LARGE');
  }
  return items;
}

function classificationLabel(
  classification: ApprovedReportDocument['sections'][number]['statements'][number]['classification'],
): string {
  switch (classification) {
    case 'human_confirmed':
      return 'Human confirmed — ';
    case 'hypothesis':
      return 'Hypothesis — ';
    case 'correlated_inference':
      return 'Correlated inference — ';
    case 'participant_assertion':
      return 'Participant assertion — ';
    case 'disputed':
      return 'Disputed — ';
    case 'unknown':
      return 'Unknown — ';
    case 'directly_observed':
    case 'corroborated':
      return '';
  }
}

function toPublishedPage(
  page: z.infer<typeof notionPageSchema>,
): PublishedReportPage {
  const url = new URL(page.url);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.hostname !== 'notion.so' && !url.hostname.endsWith('.notion.so'))
  ) {
    throw new ReportPublicationProviderError('NOTION_INVALID_PAGE_URL');
  }
  return { pageId: page.id, pageUrl: url.toString() };
}

function validatePropertyName(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ReportPublicationProviderError('NOTION_RESPONSE_TOO_LARGE');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new ReportPublicationProviderError('NOTION_INVALID_JSON', null, {
      cause: error,
    });
  }
}

function notionErrorCode(value: string): string {
  const normalized = `NOTION_${value.toUpperCase()}`;
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized)
    ? normalized
    : 'NOTION_API_ERROR';
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null || !/^\d{1,5}$/u.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}
