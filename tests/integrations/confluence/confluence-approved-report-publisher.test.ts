import { describe, expect, it, vi } from 'vitest';
import {
  ReportPublicationProviderError,
  type ApprovedReportDocument,
} from '../../../src/application/ports/approved-report-publisher.js';
import { ConfluenceApprovedReportPublisher } from '../../../src/integrations/confluence/confluence-approved-report-publisher.js';

const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const baseUrl = 'https://incident-copilot.atlassian.net';
const cloudId = '11111111-2222-3333-4444-555555555555';
const spaceId = '123456789';
const pageId = '987654321';
const pageTitle = `Incident report — Checkout outage · ${incidentId}`;

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

function page(
  title = pageTitle,
  version = { number: 4, message: 'OnRecord approved revision 2' },
): Record<string, unknown> {
  return {
    id: pageId,
    status: 'current',
    title,
    spaceId,
    version,
    _links: {
      webui: `/spaces/IR/pages/${pageId}/Incident+report`,
    },
  };
}

function document(
  statement = 'A connection pool limit caused request queuing.',
): ApprovedReportDocument {
  return {
    incidentId,
    title: 'Checkout outage',
    severity: 'SEV1',
    revisionNumber: 2,
    approvedAt: new Date('2026-07-19T01:00:00.000Z'),
    questionAnswers: [
      {
        question: 'Who approved the <break-glass> change?',
        answer:
          'The incident commander & security lead approved it.\nRecorded at 01:14 UTC.',
      },
    ],
    remainingOpenQuestions: ['Which <service owner> owns the follow-up?'],
    sections: [
      {
        sectionType: 'executive_summary',
        statements: [
          {
            text: 'Checkout requests failed for twelve minutes.',
            classification: 'directly_observed',
          },
        ],
      },
      {
        sectionType: 'root_cause',
        statements: [
          {
            text: statement,
            classification: 'human_confirmed',
          },
        ],
      },
    ],
  };
}

function publisher(request: typeof fetch): ConfluenceApprovedReportPublisher {
  return new ConfluenceApprovedReportPublisher({
    baseUrl,
    cloudId,
    email: 'publisher@example.com',
    apiToken: 'confluence-api-token',
    spaceId,
    parentPageId: '555555555',
    request,
  });
}

describe('ConfluenceApprovedReportPublisher', () => {
  it('deduplicates by stable title and creates one escaped readable page', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ results: [], _links: {} }))
      .mockResolvedValueOnce(response(page()));
    const adapter = publisher(request);

    await expect(
      adapter.publish(
        document('<script>alert("unsafe")</script> & recovery completed.'),
      ),
    ).resolves.toEqual({
      pageId,
      pageUrl: `${baseUrl}/wiki/spaces/IR/pages/${pageId}/Incident+report`,
    });
    expect(adapter.provider).toBe('CONFLUENCE');
    expect(request).toHaveBeenCalledTimes(2);

    const lookupUrl = request.mock.calls[0]?.[0];
    if (!(lookupUrl instanceof URL)) {
      throw new Error('Expected Confluence lookup URL');
    }
    const parsedLookupUrl = lookupUrl;
    expect(`${parsedLookupUrl.origin}${parsedLookupUrl.pathname}`).toBe(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/spaces/${spaceId}/pages`,
    );
    expect(Object.fromEntries(parsedLookupUrl.searchParams)).toEqual({
      title: pageTitle,
      status: 'current',
      limit: '2',
    });
    expect(request.mock.calls[0]?.[1]?.method).toBe('GET');

    const createUrl = request.mock.calls[1]?.[0];
    if (!(createUrl instanceof URL)) {
      throw new Error('Expected Confluence create URL');
    }
    expect(createUrl.toString()).toBe(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages`,
    );
    const createInit = request.mock.calls[1]?.[1];
    expect(createInit?.headers).toMatchObject({
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(
        'publisher@example.com:confluence-api-token',
      ).toString('base64')}`,
    });
    if (typeof createInit?.body !== 'string') {
      throw new Error('Expected Confluence create-page body');
    }
    const createBody = JSON.parse(createInit.body) as {
      readonly spaceId: string;
      readonly parentId: string;
      readonly title: string;
      readonly body: {
        readonly representation: string;
        readonly value: string;
      };
    };
    expect(createBody).toMatchObject({
      spaceId,
      parentId: '555555555',
      title: pageTitle,
      body: { representation: 'storage' },
    });
    expect(createBody.body.value).toContain('<h2>Root cause</h2>');
    expect(createBody.body.value).toContain(
      '<h2>Reviewed questions and answers</h2>',
    );
    expect(createBody.body.value).toContain(
      'Who approved the &lt;break-glass&gt; change?',
    );
    expect(createBody.body.value).toContain(
      'The incident commander &amp; security lead approved it.<br/>Recorded at 01:14 UTC.',
    );
    expect(createBody.body.value).toContain(
      '<h2>Remaining open questions</h2>',
    );
    expect(createBody.body.value).toContain(
      'Which &lt;service owner&gt; owns the follow-up?',
    );
    expect(createBody.body.value).toContain(
      '&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt; &amp; recovery completed.',
    );
    expect(createBody.body.value).not.toContain('<script>');
  });

  it('returns an existing exact incident page without creating another', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ results: [page()], _links: {} }));

    await expect(publisher(request).publish(document())).resolves.toEqual({
      pageId,
      pageUrl: `${baseUrl}/wiki/spaces/IR/pages/${pageId}/Incident+report`,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('updates an existing page when the approved revision is newer', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          results: [
            page(pageTitle, {
              number: 4,
              message: 'OnRecord approved revision 1',
            }),
          ],
          _links: {},
        }),
      )
      .mockResolvedValueOnce(
        response(
          page(pageTitle, {
            number: 5,
            message: 'OnRecord approved revision 2',
          }),
        ),
      );

    await expect(publisher(request).publish(document())).resolves.toEqual({
      pageId,
      pageUrl: `${baseUrl}/wiki/spaces/IR/pages/${pageId}/Incident+report`,
    });
    expect(request).toHaveBeenCalledTimes(2);
    const updateUrl = request.mock.calls[1]?.[0];
    expect(updateUrl).toBeInstanceOf(URL);
    expect((updateUrl as URL).pathname).toContain(
      `/wiki/api/v2/pages/${pageId}`,
    );
    const serializedUpdateBody = request.mock.calls[1]?.[1]?.body;
    if (typeof serializedUpdateBody !== 'string') {
      throw new Error('Expected serialized Confluence update body');
    }
    const updateBody = JSON.parse(serializedUpdateBody) as {
      readonly version: { readonly number: number; readonly message: string };
    };
    expect(updateBody.version).toEqual({
      number: 5,
      message: 'OnRecord approved revision 2',
    });
  });

  it('retains the site-specific API endpoint when no Cloud ID is configured', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ results: [page()], _links: {} }));
    const classicPublisher = new ConfluenceApprovedReportPublisher({
      baseUrl,
      email: 'publisher@example.com',
      apiToken: 'classic-api-token',
      spaceId,
      request,
    });

    await expect(classicPublisher.publish(document())).resolves.toMatchObject({
      pageUrl: `${baseUrl}/wiki/spaces/IR/pages/${pageId}/Incident+report`,
    });
    const lookupUrl = request.mock.calls[0]?.[0];
    if (!(lookupUrl instanceof URL)) {
      throw new Error('Expected classic Confluence lookup URL');
    }
    expect(`${lookupUrl.origin}${lookupUrl.pathname}`).toBe(
      `${baseUrl}/wiki/api/v2/spaces/${spaceId}/pages`,
    );
  });

  it('fails closed when the title lookup is not unique or is paginated', async () => {
    const duplicateRequest = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        results: [page(), { ...page(), id: '987654322' }],
        _links: {},
      }),
    );
    await expect(
      publisher(duplicateRequest).publish(document()),
    ).rejects.toMatchObject({
      code: 'CONFLUENCE_DUPLICATE_INCIDENT_PAGE',
    });

    const paginatedRequest = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        results: [page()],
        _links: { next: '/wiki/api/v2/spaces/123/pages?cursor=opaque' },
      }),
    );
    await expect(
      publisher(paginatedRequest).publish(document()),
    ).rejects.toMatchObject({
      code: 'CONFLUENCE_DUPLICATE_INCIDENT_PAGE',
    });
  });

  it('recovers a create conflict by repeating the exact lookup', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ results: [], _links: {} }))
      .mockResolvedValueOnce(response({ message: 'conflict' }, 409))
      .mockResolvedValueOnce(response({ results: [page()], _links: {} }));

    await expect(publisher(request).publish(document())).resolves.toEqual({
      pageId,
      pageUrl: `${baseUrl}/wiki/spaces/IR/pages/${pageId}/Incident+report`,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('returns a bounded provider-directed retry for rate limiting', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({ message: 'sensitive details' }, 429, {
        'retry-after': '45',
      }),
    );
    const failure = publisher(request).publish(document());

    await expect(failure).rejects.toBeInstanceOf(
      ReportPublicationProviderError,
    );
    await expect(failure).rejects.toMatchObject({
      code: 'CONFLUENCE_RATE_LIMITED',
      retryAfterSeconds: 45,
    });
  });

  it('rejects an SSRF-capable base URL before making a request', () => {
    expect(
      () =>
        new ConfluenceApprovedReportPublisher({
          baseUrl: 'https://internal.example.test',
          email: 'publisher@example.com',
          apiToken: 'confluence-api-token',
          spaceId,
        }),
    ).toThrow('plain HTTPS atlassian.net origin');
  });

  it('rejects a Cloud ID that could alter the API gateway path', () => {
    expect(
      () =>
        new ConfluenceApprovedReportPublisher({
          baseUrl,
          cloudId: '../another-tenant',
          email: 'publisher@example.com',
          apiToken: 'confluence-api-token',
          spaceId,
        }),
    ).toThrow();
  });

  it('rejects an untrusted page URL returned by Confluence', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        results: [
          {
            ...page(),
            _links: { webui: 'https://attacker.example/report' },
          },
        ],
        _links: {},
      }),
    );

    await expect(publisher(request).publish(document())).rejects.toMatchObject({
      code: 'CONFLUENCE_INVALID_PAGE_URL',
    });
  });
});
