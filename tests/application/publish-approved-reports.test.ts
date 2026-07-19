import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovedReportPublicationJob,
  ApprovedReportPublicationRepository,
} from '../../src/application/ports/approved-report-publication-repository.js';
import {
  ReportPublicationProviderError,
  type ApprovedReportPublisher,
  type ReportPublicationProvider,
} from '../../src/application/ports/approved-report-publisher.js';
import type { IncidentReportPublishedNotifier } from '../../src/application/ports/incident-report-published-notifier.js';
import {
  PublishApprovedReports,
  type PublishApprovedReportsResult,
} from '../../src/application/publish-approved-reports.js';

const now = new Date('2026-07-19T01:00:00.000Z');

function job(
  overrides: Partial<ApprovedReportPublicationJob> = {},
): ApprovedReportPublicationJob {
  return {
    id: 'publication:617b5728-8404-4934-a616-1a319ba72b7f',
    tenantId: 'T001',
    incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
    revisionId: '617b5728-8404-4934-a616-1a319ba72b7f',
    status: 'PENDING',
    attemptCount: 1,
    publisher: 'NOTION',
    publishedPageId: null,
    publishedPageUrl: null,
    workspaceId: 'T001',
    channelId: 'C001',
    threadTs: '1721178000.000100',
    document: {
      incidentId: '2c6a2f4a-f762-41e9-9620-a07abdaa5c48',
      title: 'Checkout outage',
      severity: 'SEV1',
      revisionNumber: 2,
      approvedAt: now,
      questionAnswers: [],
      remainingOpenQuestions: [],
      sections: [
        {
          sectionType: 'root_cause',
          statements: [
            {
              text: 'A connection pool limit caused request queuing.',
              classification: 'human_confirmed',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function dependencies(
  inputJob: ApprovedReportPublicationJob,
  provider: ReportPublicationProvider = 'NOTION',
): {
  readonly repository: ApprovedReportPublicationRepository;
  readonly claimNext: ReturnType<typeof vi.fn>;
  readonly markPagePublished: ReturnType<typeof vi.fn>;
  readonly markComplete: ReturnType<typeof vi.fn>;
  readonly recordFailure: ReturnType<typeof vi.fn>;
  readonly publisher: ApprovedReportPublisher;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly notifier: IncidentReportPublishedNotifier;
  readonly notifyReportPublished: ReturnType<typeof vi.fn>;
} {
  const claimNext = vi
    .fn<ApprovedReportPublicationRepository['claimNext']>()
    .mockResolvedValueOnce(inputJob)
    .mockResolvedValue(null);
  const markPagePublished =
    vi.fn<ApprovedReportPublicationRepository['markPagePublished']>();
  const markComplete =
    vi.fn<ApprovedReportPublicationRepository['markComplete']>();
  const recordFailure =
    vi.fn<ApprovedReportPublicationRepository['recordFailure']>();
  const publish = vi
    .fn<ApprovedReportPublisher['publish']>()
    .mockResolvedValue({
      pageId: '01234567-89ab-cdef-0123-456789abcdef',
      pageUrl:
        'https://www.notion.so/Checkout-outage-0123456789abcdef0123456789abcdef',
    });
  const notifyReportPublished = vi
    .fn<IncidentReportPublishedNotifier['notifyReportPublished']>()
    .mockResolvedValue({ messageTs: '1721178002.000300' });
  return {
    repository: {
      claimNext,
      markPagePublished,
      markComplete,
      recordFailure,
    },
    claimNext,
    markPagePublished,
    markComplete,
    recordFailure,
    publisher: { provider, publish },
    publish,
    notifier: { notifyReportPublished },
    notifyReportPublished,
  };
}

async function execute(
  deps: ReturnType<typeof dependencies>,
  maxAttempts = 8,
): Promise<PublishApprovedReportsResult> {
  return new PublishApprovedReports(
    deps.repository,
    deps.publisher,
    deps.notifier,
    { now: () => now },
  ).execute({
    workerId: 'scheduled-event-id',
    maxJobs: 2,
    maxAttempts,
    leaseSeconds: 180,
    retryBaseSeconds: 60,
  });
}

describe('PublishApprovedReports', () => {
  it('checkpoints the provider page before sending and completing the Slack notification', async () => {
    const deps = dependencies(job());

    await expect(execute(deps)).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retryScheduled: 0,
      terminalFailures: 0,
    });
    expect(deps.publish).toHaveBeenCalledOnce();
    expect(deps.markPagePublished).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job().id,
        workerId: 'scheduled-event-id',
        publisher: 'NOTION',
      }),
    );
    expect(deps.notifyReportPublished).toHaveBeenCalledWith({
      workspaceId: 'T001',
      incidentId: job().incidentId,
      revisionId: job().revisionId,
      channelId: 'C001',
      threadTs: '1721178000.000100',
      publisher: 'NOTION',
      reportPageUrl:
        'https://www.notion.so/Checkout-outage-0123456789abcdef0123456789abcdef',
    });
    expect(deps.markComplete).toHaveBeenCalledWith(
      expect.objectContaining({ slackMessageTs: '1721178002.000300' }),
    );
    expect(deps.markPagePublished.mock.invocationCallOrder[0]).toBeLessThan(
      deps.notifyReportPublished.mock.invocationCallOrder[0] ?? 0,
    );
    expect(deps.claimNext).toHaveBeenCalledWith(
      expect.objectContaining({ publisher: 'NOTION' }),
    );
  });

  it('resumes at Slack when a provider checkpoint already exists', async () => {
    const deps = dependencies(
      job({
        status: 'PAGE_PUBLISHED',
        publishedPageId: '01234567-89ab-cdef-0123-456789abcdef',
        publishedPageUrl:
          'https://www.notion.so/Checkout-0123456789abcdef0123456789abcdef',
      }),
    );

    await expect(execute(deps)).resolves.toMatchObject({ completed: 1 });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.markPagePublished).not.toHaveBeenCalled();
    expect(deps.notifyReportPublished).toHaveBeenCalledOnce();
  });

  it('finishes Slack delivery for a Notion checkpoint after switching to Confluence', async () => {
    const deps = dependencies(
      job({
        status: 'PAGE_PUBLISHED',
        publisher: 'NOTION',
        publishedPageId: '01234567-89ab-cdef-0123-456789abcdef',
        publishedPageUrl:
          'https://www.notion.so/Checkout-0123456789abcdef0123456789abcdef',
      }),
      'CONFLUENCE',
    );

    await expect(execute(deps)).resolves.toMatchObject({ completed: 1 });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.notifyReportPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        publisher: 'NOTION',
        reportPageUrl:
          'https://www.notion.so/Checkout-0123456789abcdef0123456789abcdef',
      }),
    );
  });

  it('persists a bounded provider retry without notifying Slack', async () => {
    const deps = dependencies(job());
    deps.publish.mockRejectedValueOnce(
      new ReportPublicationProviderError('NOTION_RATE_LIMITED', 90),
    );

    await expect(execute(deps)).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retryScheduled: 1,
      terminalFailures: 0,
    });
    expect(deps.notifyReportPublished).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledWith({
      jobId: job().id,
      workerId: 'scheduled-event-id',
      errorCode: 'NOTION_RATE_LIMITED',
      retryAt: new Date('2026-07-19T01:01:30.000Z'),
      failedAt: now,
      terminal: false,
    });
  });

  it('marks the job terminal after the configured final attempt', async () => {
    const deps = dependencies(job({ attemptCount: 3 }));
    deps.notifyReportPublished.mockRejectedValueOnce(
      new ReportPublicationProviderError('SLACK_NOT_IN_CHANNEL'),
    );

    await expect(execute(deps, 3)).resolves.toMatchObject({
      completed: 0,
      terminalFailures: 1,
    });
    expect(deps.markPagePublished).toHaveBeenCalledOnce();
    expect(deps.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'SLACK_NOT_IN_CHANNEL',
        terminal: true,
      }),
    );
  });
});
