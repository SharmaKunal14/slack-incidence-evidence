import { describe, expect, it, vi } from 'vitest';
import type { IncidentReviewRepository } from '../../src/application/ports/incident-review-repository.js';
import {
  ApproveReportRevision,
  CreateReportRevision,
  GetReportRevision,
  ListIncidentReviews,
} from '../../src/application/review-incident.js';
import {
  ReviewAuthorizationError,
  ReviewValidationError,
  type IncidentReviewBundle,
} from '../../src/application/review/incident-review.js';
import type { CreateReportRevisionInput } from '../../src/application/ports/incident-review-repository.js';

const incidentId = '2c6a2f4a-f762-41e9-9620-a07abdaa5c48';
const reportDraftId = '7df1bcac-5583-4cd6-91db-981989f4c482';
const revisionId = '617b5728-8404-4934-a616-1a319ba72b7f';
const requestId = 'd61ad8d8-5111-4ce0-a044-1addc5bf0414';
const reviewer = { subject: '9f218e92-36a8-455d-869c-a76e27b399df' };
const now = new Date('2026-07-18T01:00:00.000Z');

function bundle(): IncidentReviewBundle {
  return {
    incident: {
      id: incidentId,
      title: 'Checkout latency',
      severity: 'SEV1',
      status: 'NEEDS_REVIEW',
      version: 4,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:30:00.000Z',
    },
    reportDraft: {
      id: reportDraftId,
      draftVersion: 1,
      renderedMarkdown: '# AI draft',
    },
    sections: [
      {
        sectionType: 'root_cause',
        position: 0,
        statements: [
          {
            id: 'statement-1',
            sectionType: 'root_cause',
            position: 0,
            statementType: 'claim',
            text: 'A deploy probably increased database latency.',
            classification: 'hypothesis',
            claimIds: ['claim-1'],
            timelineEventIds: [],
          },
        ],
      },
    ],
    claims: [
      {
        id: 'claim-1',
        statement: 'A deploy increased database latency.',
        classification: 'disputed',
        reviewStatus: 'NEEDS_REVIEW',
        supportingEvidenceIds: ['evidence-1'],
        contradictingEvidenceIds: ['evidence-2'],
      },
    ],
    timeline: [],
    evidence: [],
    openQuestions: [{ id: 'question-1', question: 'Which query regressed?' }],
    revisions: [],
    latestRevision: null,
  };
}

function repository(): {
  readonly listInbox: ReturnType<
    typeof vi.fn<IncidentReviewRepository['listInbox']>
  >;
  readonly loadBundle: ReturnType<
    typeof vi.fn<IncidentReviewRepository['loadBundle']>
  >;
  readonly loadRevision: ReturnType<
    typeof vi.fn<IncidentReviewRepository['loadRevision']>
  >;
  readonly createRevision: ReturnType<
    typeof vi.fn<IncidentReviewRepository['createRevision']>
  >;
  readonly approveRevision: ReturnType<
    typeof vi.fn<IncidentReviewRepository['approveRevision']>
  >;
} {
  const createdRevision = {
    id: revisionId,
    tenantId: 'tenant-1',
    incidentId,
    reportDraftId,
    revisionNumber: 1,
    status: 'DRAFT' as const,
    createdBySubject: reviewer.subject,
    acknowledgedContradictions: true,
    acknowledgedOpenQuestions: true,
    statementCount: 1,
    renderedMarkdown: '# Reviewed',
    contentSha256: 'a'.repeat(64),
    createdAt: now,
    approvedBySubject: null,
    approvedAt: null,
  };
  return {
    listInbox: vi
      .fn<IncidentReviewRepository['listInbox']>()
      .mockResolvedValue({
        authorized: true,
        page: { items: [], nextCursor: null },
      }),
    loadBundle: vi
      .fn<IncidentReviewRepository['loadBundle']>()
      .mockResolvedValue(bundle()),
    loadRevision: vi
      .fn<IncidentReviewRepository['loadRevision']>()
      .mockResolvedValue(null),
    createRevision: vi
      .fn<IncidentReviewRepository['createRevision']>()
      .mockResolvedValue(createdRevision),
    approveRevision: vi
      .fn<IncidentReviewRepository['approveRevision']>()
      .mockResolvedValue(createdRevision),
  };
}

function createCommand(): {
  readonly incidentId: string;
  readonly reportDraftId: string;
  readonly expectedIncidentVersion: number;
  readonly clientRequestId: string;
  readonly acknowledgedContradictions: boolean;
  readonly acknowledgedOpenQuestions: boolean;
  readonly decisions: readonly [
    { readonly statementId: string; readonly decision: 'KEEP' },
  ];
} {
  return {
    incidentId,
    reportDraftId,
    expectedIncidentVersion: 4,
    clientRequestId: requestId,
    acknowledgedContradictions: true,
    acknowledgedOpenQuestions: true,
    decisions: [{ statementId: 'statement-1', decision: 'KEEP' as const }],
  };
}

describe('human incident review', () => {
  it('loads a specifically requested immutable revision', async () => {
    const reviews = repository();
    reviews.loadRevision.mockResolvedValueOnce({
      id: revisionId,
      revisionNumber: 1,
      status: 'APPROVED',
      createdAt: now.toISOString(),
      statementCount: 1,
      acknowledgedContradictions: true,
      acknowledgedOpenQuestions: true,
      questionAnswers: [],
      statements: [
        {
          originalStatementId: 'statement-1',
          sectionType: 'root_cause',
          position: 0,
          decision: 'KEEP',
          text: 'A deploy probably increased database latency.',
          classification: 'hypothesis',
        },
      ],
    });

    await expect(
      new GetReportRevision(reviews).execute({
        reviewer,
        incidentId,
        revisionId,
      }),
    ).resolves.toMatchObject({ id: revisionId, status: 'APPROVED' });
    expect(reviews.loadRevision).toHaveBeenCalledWith(
      reviewer,
      incidentId,
      revisionId,
    );
  });

  it('denies an identity without an active tenant membership', async () => {
    const reviews = repository();
    reviews.listInbox.mockResolvedValueOnce({
      authorized: false,
      page: { items: [], nextCursor: null },
    });

    await expect(
      new ListIncidentReviews(reviews).execute({
        reviewer,
        limit: 20,
        cursor: null,
      }),
    ).rejects.toBeInstanceOf(ReviewAuthorizationError);
  });

  it('requires explicit acknowledgement of contradictions and open questions', async () => {
    const reviews = repository();
    const useCase = new CreateReportRevision(
      reviews,
      { now: () => now },
      { generate: () => revisionId },
    );

    await expect(
      useCase.execute({
        reviewer,
        command: {
          ...createCommand(),
          acknowledgedContradictions: false,
        },
      }),
    ).rejects.toBeInstanceOf(ReviewValidationError);
    await expect(
      useCase.execute({
        reviewer,
        command: {
          ...createCommand(),
          acknowledgedOpenQuestions: false,
        },
      }),
    ).rejects.toBeInstanceOf(ReviewValidationError);
    expect(reviews.createRevision).not.toHaveBeenCalled();
  });

  it('does not allow an edit to silently strengthen model certainty', async () => {
    const reviews = repository();
    const useCase = new CreateReportRevision(
      reviews,
      { now: () => now },
      { generate: () => revisionId },
    );

    await expect(
      useCase.execute({
        reviewer,
        command: {
          ...createCommand(),
          decisions: [
            {
              statementId: 'statement-1',
              decision: 'EDIT',
              text: 'The deploy increased database latency.',
              classification: 'directly_observed',
            },
          ],
        },
      }),
    ).rejects.toThrow('cannot silently strengthen');
  });

  it('persists a source-linked immutable revision marked human-confirmed', async () => {
    const reviews = repository();
    const ids = [
      '4b2032ad-c25f-4f7d-a351-5f472019e588',
      revisionId,
      'bf6b4219-e1ad-475d-a302-731522e605d4',
    ];
    const useCase = new CreateReportRevision(
      reviews,
      { now: () => now },
      { generate: () => ids.shift() ?? revisionId },
    );

    await useCase.execute({
      reviewer,
      command: {
        ...createCommand(),
        decisions: [
          {
            statementId: 'statement-1',
            decision: 'EDIT',
            text: 'The on-call confirmed that the deploy increased latency.',
            classification: 'human_confirmed',
          },
        ],
      },
    });

    const persisted: CreateReportRevisionInput | undefined =
      reviews.createRevision.mock.calls[0]?.[0];
    if (persisted === undefined) {
      throw new Error('Expected a persisted review revision');
    }
    expect(persisted).toMatchObject({
      incidentId,
      reportDraftId,
      expectedIncidentVersion: 4,
      clientRequestId: requestId,
    });
    expect(persisted.requestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted.renderedMarkdown).toContain('**Human confirmed:**');
    expect(persisted.renderedMarkdown).toContain('## Remaining open questions');
    expect(persisted.renderedMarkdown).toContain('Which query regressed?');
    expect(persisted.statements).toEqual([
      expect.objectContaining({
        originalStatementId: 'statement-1',
        classification: 'human_confirmed',
        claimIds: ['claim-1'],
      }),
    ]);
  });

  it('preserves reviewed open-question answers in the immutable content', async () => {
    const reviews = repository();
    const useCase = new CreateReportRevision(
      reviews,
      { now: () => now },
      { generate: () => revisionId },
    );

    await useCase.execute({
      reviewer,
      command: {
        ...createCommand(),
        questionAnswers: [
          {
            questionId: 'question-1',
            answer: 'The checkout_read query regressed after the deploy.',
          },
        ],
      },
    });

    const persisted = reviews.createRevision.mock.calls[0]?.[0];
    expect(persisted?.questionAnswers).toEqual([
      {
        id: revisionId,
        questionId: 'question-1',
        question: 'Which query regressed?',
        answer: 'The checkout_read query regressed after the deploy.',
      },
    ]);
    expect(persisted?.renderedMarkdown).toContain(
      '## Reviewed questions and answers',
    );
    expect(persisted?.renderedMarkdown).toContain('Which query regressed?');
  });

  it('rejects an answer that points outside the incident questions', async () => {
    const reviews = repository();
    const useCase = new CreateReportRevision(
      reviews,
      { now: () => now },
      { generate: () => revisionId },
    );

    await expect(
      useCase.execute({
        reviewer,
        command: {
          ...createCommand(),
          questionAnswers: [
            { questionId: 'question-from-another-incident', answer: 'No.' },
          ],
        },
      }),
    ).rejects.toThrow('unknown open question');
    expect(reviews.createRevision).not.toHaveBeenCalled();
  });

  it('passes identity, concurrency version, and request ID to atomic approval', async () => {
    const reviews = repository();
    const useCase = new ApproveReportRevision(
      reviews,
      { now: () => now },
      { generate: () => '9bda3845-c33b-4cc7-bd60-9291178ae725' },
    );

    await useCase.execute({
      reviewer,
      command: {
        incidentId,
        revisionId,
        expectedIncidentVersion: 4,
        clientRequestId: requestId,
      },
    });

    expect(reviews.approveRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewer,
        incidentId,
        revisionId,
        expectedIncidentVersion: 4,
        clientRequestId: requestId,
        approvedAt: now,
      }),
    );
  });
});
