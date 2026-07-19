import { describe, expect, it, vi } from 'vitest';
import { ReportPublicationProviderError } from '../../../src/application/ports/approved-report-publisher.js';
import type { ApprovedReportDocument } from '../../../src/application/ports/approved-report-publisher.js';
import { NotionApprovedReportPublisher } from '../../../src/integrations/notion/notion-approved-report-publisher.js';

const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const dataSourceId = '0123456789abcdef0123456789abcdef';
const pageId = '12345678-1234-1234-1234-123456789abc';
const pageUrl =
  'https://www.notion.so/Checkout-outage-12345678123412341234123456789abc';

function response(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function document(): ApprovedReportDocument {
  return {
    incidentId,
    title: 'Checkout outage',
    severity: 'SEV1',
    revisionNumber: 2,
    approvedAt: new Date('2026-07-19T01:00:00.000Z'),
    sections: [
      {
        sectionType: 'executive_summary' as const,
        statements: [
          {
            text: 'Checkout requests failed for twelve minutes.',
            classification: 'directly_observed' as const,
          },
        ],
      },
      {
        sectionType: 'root_cause' as const,
        statements: [
          {
            text: 'A connection pool limit caused request queuing.',
            classification: 'human_confirmed' as const,
          },
        ],
      },
    ],
  };
}

describe('NotionApprovedReportPublisher', () => {
  it('deduplicates by incident ID and creates one complete readable page', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ object: 'list', results: [], has_more: false }),
      )
      .mockResolvedValueOnce(
        response({ object: 'page', id: pageId, url: pageUrl, in_trash: false }),
      );
    const publisher = new NotionApprovedReportPublisher({
      apiToken: 'secret-notion-token',
      dataSourceId,
      titleProperty: 'Name',
      incidentIdProperty: 'Incident ID',
      request,
    });

    await expect(publisher.publish(document())).resolves.toEqual({
      pageId,
      pageUrl,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
    );
    const queryBody = request.mock.calls[0]?.[1]?.body;
    if (typeof queryBody !== 'string') {
      throw new Error('Expected Notion query body');
    }
    expect(JSON.parse(queryBody)).toEqual({
      filter: {
        property: 'Incident ID',
        rich_text: { equals: incidentId },
      },
      page_size: 2,
    });

    const createInit = request.mock.calls[1]?.[1];
    expect(createInit?.headers).toMatchObject({
      authorization: 'Bearer secret-notion-token',
      'notion-version': '2026-03-11',
    });
    if (typeof createInit?.body !== 'string') {
      throw new Error('Expected Notion create-page body');
    }
    const createBody = JSON.parse(createInit.body) as {
      readonly parent: unknown;
      readonly properties: Record<string, unknown>;
      readonly children: readonly unknown[];
    };
    expect(createBody.parent).toEqual({
      type: 'data_source_id',
      data_source_id: dataSourceId,
    });
    expect(createBody.properties).toHaveProperty('Name');
    expect(createBody.properties).toHaveProperty('Incident ID');
    expect(createBody.children.length).toBeLessThanOrEqual(100);
    expect(createInit.body).toContain('Root cause');
    expect(createInit.body).toContain('Human confirmed');
  });

  it('returns the existing exact incident page without creating another', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        object: 'list',
        results: [
          { object: 'page', id: pageId, url: pageUrl, in_trash: false },
        ],
        has_more: false,
      }),
    );
    const publisher = new NotionApprovedReportPublisher({
      apiToken: 'secret-notion-token',
      dataSourceId,
      titleProperty: 'Name',
      incidentIdProperty: 'Incident ID',
      request,
    });

    await expect(publisher.publish(document())).resolves.toEqual({
      pageId,
      pageUrl,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('fails closed when the deduplication property is not unique', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        object: 'list',
        results: [
          { object: 'page', id: pageId, url: pageUrl, in_trash: false },
          {
            object: 'page',
            id: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
            url: 'https://www.notion.so/Duplicate-abcdefabcdefabcdefabcdefabcdefab',
            in_trash: false,
          },
        ],
        has_more: false,
      }),
    );
    const publisher = new NotionApprovedReportPublisher({
      apiToken: 'secret-notion-token',
      dataSourceId,
      titleProperty: 'Name',
      incidentIdProperty: 'Incident ID',
      request,
    });

    await expect(publisher.publish(document())).rejects.toMatchObject({
      code: 'NOTION_DUPLICATE_INCIDENT_PAGE',
    });
  });

  it('returns a safe provider-directed retry for Notion rate limiting', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          { object: 'error', code: 'rate_limited', message: 'secret details' },
          429,
          { 'retry-after': '45' },
        ),
      );
    const publisher = new NotionApprovedReportPublisher({
      apiToken: 'secret-notion-token',
      dataSourceId,
      titleProperty: 'Name',
      incidentIdProperty: 'Incident ID',
      request,
    });

    const failure = publisher.publish(document());
    await expect(failure).rejects.toBeInstanceOf(
      ReportPublicationProviderError,
    );
    await expect(failure).rejects.toMatchObject({
      code: 'NOTION_RATE_LIMITED',
      retryAfterSeconds: 45,
    });
  });
});
